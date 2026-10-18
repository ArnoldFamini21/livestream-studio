export interface ParticipantRecordingSaveOptions {
  saveLocal: () => Promise<unknown>;
  finishProgressive?: () => Promise<unknown>;
  uploadFull: () => Promise<unknown>;
}

export interface ParticipantRecordingSaveResult {
  localSaved: boolean;
  cloudSaved: boolean;
  localError?: unknown;
  progressiveError?: unknown;
  cloudError?: unknown;
}

/** Local quota failures must never prevent the independent cloud copy. */
export async function saveParticipantRecording(
  options: ParticipantRecordingSaveOptions,
): Promise<ParticipantRecordingSaveResult> {
  const result: ParticipantRecordingSaveResult = { localSaved: false, cloudSaved: false };
  try {
    await options.saveLocal();
    result.localSaved = true;
  } catch (error) {
    result.localError = error;
  }

  if (options.finishProgressive) {
    try {
      await options.finishProgressive();
      result.cloudSaved = true;
      return result;
    } catch (error) {
      result.progressiveError = error;
    }
  }

  try {
    await options.uploadFull();
    result.cloudSaved = true;
  } catch (error) {
    result.cloudError = error;
  }
  return result;
}
