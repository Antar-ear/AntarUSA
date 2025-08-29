// Azure STT helper (single-shot) using push stream with 16k PCM
const sdk = require('microsoft-cognitiveservices-speech-sdk');

/**
 * Transcribe a single PCM buffer (16kHz, 16-bit, mono LE)
 * @param {Buffer} audioBuffer
 * @param {string} fromLang e.g., 'hi-IN' or 'en-US'
 * @returns {Promise<{transcript:string, confidence:number}>}
 */
async function transcribeOnce(audioBuffer, fromLang = 'hi-IN') {
  if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
    throw new Error('Azure Speech credentials missing');
  }
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY,
    process.env.AZURE_SPEECH_REGION
  );
  speechConfig.speechRecognitionLanguage = fromLang;

  const pushStream = sdk.AudioInputStream.createPushStream(
    sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
  );
  pushStream.write(audioBuffer);
  pushStream.close();

  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  const result = await new Promise((resolve, reject) => {
    recognizer.recognizeOnceAsync(
      r => resolve(r),
      e => reject(e)
    );
  });

  recognizer.close();

  if (result.reason === sdk.ResultReason.RecognizedSpeech) {
    return { transcript: result.text || '', confidence: 0.95 };
  }
  if (result.reason === sdk.ResultReason.NoMatch) {
    return { transcript: '', confidence: 0.0 };
  }
  throw new Error(result.errorDetails || 'Azure STT failed');
}

module.exports = { transcribeOnce };
