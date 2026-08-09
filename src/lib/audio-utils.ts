/**
 * Convert a MediaRecorder blob (audio/webm;codecs=opus) to 16 kHz mono 16-bit PCM WAV
 * using the Web Audio API. No external dependencies.
 *
 * Flow: blob.arrayBuffer() → AudioContext.decodeAudioData() → OfflineAudioContext
 * resample to mono 16 kHz → encode as 16-bit PCM WAV (RIFF/fmt/data header).
 */

const TARGET_SAMPLE_RATE = 16000;

/**
 * Encode an AudioBuffer as a 16-bit PCM WAV Blob (mono, 16 kHz).
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = 1; // mono
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;

  // We render via OfflineAudioContext at 16 kHz, but this function is called
  // on the *rendered* buffer, so sampleRate should already be 16000.
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write interleaved PCM samples (mono, so just one channel)
  const channelData = buffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const sample = Math.max(-1, Math.min(1, channelData[i]));
    // Convert to 16-bit signed integer
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Convert a webm/opus blob to 16 kHz mono 16-bit WAV.
 *
 * @param blob The audio blob from MediaRecorder (typically audio/webm;codecs=opus)
 * @returns A WAV blob at 16 kHz mono 16-bit PCM
 */
export async function convertBlobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();

  // Decode the compressed audio into a raw AudioBuffer
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  audioCtx.close();

  // Resample to mono 16 kHz using OfflineAudioContext
  const duration = audioBuffer.duration;
  const numFrames = Math.ceil(duration * TARGET_SAMPLE_RATE);

  const offlineCtx = new OfflineAudioContext(1, numFrames, TARGET_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();

  return audioBufferToWav(renderedBuffer);
}