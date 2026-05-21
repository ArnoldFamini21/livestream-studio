import { useCallback, useEffect, useState } from 'react';
import {
  addPhoto as dbAdd,
  listPhotos as dbList,
  removePhoto as dbRemove,
  type LibraryPhoto,
} from '../utils/photoLibrary.ts';

// Cross-tab / cross-component sync: emit on the window when the library changes
// so multiple usePhotoLibrary consumers stay aligned.
const EVENT = 'photo-library:changed';

export function usePhotoLibrary() {
  const [photos, setPhotos] = useState<LibraryPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await dbList();
      setPhotos(list);
      setError(null);
    } catch (err) {
      console.error('Failed to load photo library:', err);
      setError('Could not load your background library.');
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await refresh();
      if (mounted) setLoading(false);
    })();
    const handler = () => { void refresh(); };
    window.addEventListener(EVENT, handler);
    return () => {
      mounted = false;
      window.removeEventListener(EVENT, handler);
    };
  }, [refresh]);

  const addPhoto = useCallback(async (file: File): Promise<LibraryPhoto | null> => {
    try {
      const photo = await dbAdd(file);
      window.dispatchEvent(new Event(EVENT));
      setError(null);
      return photo;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add photo';
      setError(msg);
      return null;
    }
  }, []);

  const removePhoto = useCallback(async (id: string): Promise<void> => {
    try {
      await dbRemove(id);
      window.dispatchEvent(new Event(EVENT));
    } catch (err) {
      console.error('Failed to remove photo:', err);
    }
  }, []);

  return { photos, loading, error, addPhoto, removePhoto, clearError: () => setError(null) };
}
