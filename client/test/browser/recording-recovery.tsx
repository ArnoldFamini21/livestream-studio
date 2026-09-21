// Manual regression in the Codex browser: record > reload without stopping >
// recover > preview. Normal saves keep original Blobs readable for uploads;
// navigating away permits cleanup of acknowledged fragments.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useRecording } from '../../src/hooks/useRecording.ts';
import { useLocalRecording } from '../../src/hooks/useLocalRecording.ts';
import { useRecordingLibrary } from '../../src/hooks/useRecordingLibrary.ts';
import { RecordingRecoveryNotice } from '../../src/components/RecordingRecoveryNotice.tsx';
import { listRecoverableRecordings } from '../../src/utils/recordingRecovery.ts';
import { getRecordingFileExtension } from '../../src/utils/recordingMimeTypes.ts';
import '../../src/styles/global.css';
import '../../src/styles/recording-recovery.css';

function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState('Ready');
  const [preview, setPreview] = useState('');
  const program = useRecording('Recovery browser test');
  const local = useLocalRecording('Isolated browser test');
  const library = useRecordingLibrary();
  useEffect(() => {
    const context = canvas.current!.getContext('2d')!;
    let frame = 0;
    const draw = () => {
      context.fillStyle = '#242234'; context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#b7a6ed'; context.beginPath(); context.arc(320, 150, 65, 0, Math.PI * 2); context.fill();
      context.font = '24px sans-serif'; context.fillStyle = 'white'; context.fillText(new Date().toLocaleTimeString(), 235, 270);
      frame = requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.current!.captureStream(15); setStream(stream);
    return () => { cancelAnimationFrame(frame); stream.getTracks().forEach(track => track.stop()); };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const busy = program.isRecording || local.isRecording;
  const stop = async () => {
    try {
      const files = local.isRecording ? (await local.stopRecording()).files : [...(await program.stopRecording()).values()].map(track => ({ label: track.name, kind: track.kind, blob: track.blob }));
      await library.saveSession({ roomName: 'Saved browser test', files: files.map((file, i) => ({ ...file, fileName: `track-${i}.${getRecordingFileExtension(file.blob.type)}` })) });
      // Original blobs are still used for export/upload after the library save.
      const original = files.find(file => file.blob.type.startsWith('video/'))!.blob;
      const bytes = (await original.arrayBuffer()).byteLength;
      setPreview(URL.createObjectURL(original));
      setStatus(`Saved. Original blob readable: ${bytes} bytes. Recoverable tracks remaining: ${(await listRecoverableRecordings()).length}`);
    } catch (error) { setStatus(String(error)); }
  };
  return <main style={{ maxWidth: 840, margin: '24px auto', padding: 20 }}>
    <h1>Recording recovery regression</h1>
    <canvas ref={canvas} width={640} height={360} style={{ width: 400, maxWidth: '100%', display: 'block', margin: '20px 0' }} />
    <button disabled={!stream || busy} onClick={() => program.startRecording(new Map([['program', {stream: stream!, name:'Program', isLocal:true, kind:'program'}]]))}>Record program</button>
    <button disabled={!stream || busy} onClick={() => void local.startRecording([{id:'camera',label:'Camera',kind:'video',stream:stream!}])}>Record isolated track</button>
    <button disabled={!busy} onClick={() => void stop()}>Stop and save</button>
    <button onClick={() => location.reload()}>Interrupt and reload</button>
    <p role="status">{busy ? `Recording ${program.isRecording ? program.formattedTime : local.formattedTime}` : status}</p>
    {(program.storageWarning || local.storageWarning) && <p role="alert">{program.storageWarning || local.storageWarning}</p>}
    <RecordingRecoveryNotice onRecovered={library.refresh} />
    <h2>Library</h2>
    {library.sessions.map(session => <p key={session.id}>{session.roomName} · {session.trackCount} tracks <button onClick={() => void library.loadFiles(session.id).then(files => setPreview(URL.createObjectURL(files.find(file => file.blob.type.startsWith('video/'))!.blob)))}>Preview {session.roomName}</button></p>)}
    {preview && <video aria-label="Recovered recording preview" src={preview} controls autoPlay muted style={{width:640,maxWidth:'100%'}} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
