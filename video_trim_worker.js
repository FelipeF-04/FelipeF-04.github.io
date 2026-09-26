function toErrorDetails(error, fallbackMessage) {
  if (error && typeof error === 'object') {
    let message = error.message;
    if (!message) {
      try {
        message = JSON.stringify(error);
      } catch (_) {
        message = fallbackMessage;
      }
    }

    return {
      name: error.name || 'Error',
      message: message || fallbackMessage,
      status: typeof error.status === 'number' ? error.status : undefined,
      stack: typeof error.stack === 'string' ? error.stack : undefined,
    };
  }

  return {
    name: 'Error',
    message: error == null ? fallbackMessage : String(error),
  };
}

function postFailure(requestId, stage, error, fallbackMessage) {
  self.postMessage({
    requestId,
    ok: false,
    stage,
    error: toErrorDetails(error, fallbackMessage),
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function rotationFilter(rotationDegrees) {
  const normalized = ((rotationDegrees % 360) + 360) % 360;
  if (normalized === 90) return 'transpose=1';
  if (normalized === 180) return 'transpose=1,transpose=1';
  if (normalized === 270) return 'transpose=2';
  return null;
}

async function loadFreshFfmpeg() {
  if (!self.FFmpeg || !self.FFmpeg.createFFmpeg) {
    throw new Error('FFmpeg wasm runtime missing from Worker.');
  }

  const coreCandidates = [
    {
      corePath:
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.11.0/dist/ffmpeg-core.js',
      mainName: 'main',
    },
    {
      corePath:
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    },
  ];
  const failures = [];

  for (const candidate of coreCandidates) {
    const options = {
      log: false,
      corePath: candidate.corePath,
    };
    if (candidate.mainName) options.mainName = candidate.mainName;

    try {
      const ffmpeg = self.FFmpeg.createFFmpeg(options);
      await ffmpeg.load();
      return ffmpeg;
    } catch (error) {
      failures.push({
        corePath: candidate.corePath,
        ...toErrorDetails(error, 'FFmpeg core candidate failed to load.'),
      });
    }
  }

  const error = new Error('Failed to load FFmpeg core from all candidates.');
  error.name = 'FfmpegInitializationError';
  error.candidates = failures;
  error.message += ` ${failures
    .map((failure) => `${failure.corePath}: ${failure.name}: ${failure.message}`)
    .join(' | ')}`;
  throw error;
}

self.onmessage = async function (event) {
  const request = event.data || {};
  const requestId = request.requestId;
  let stage = 'initialization';
  let ffmpeg;
  let inputName;
  let outputName;

  try {
    // @ffmpeg/ffmpeg 0.11.6's UMD bundle reads document.baseURI during module
    // initialization, even when its WorkerGlobalScope code path is used.
    self.document = { baseURI: self.location.href };
    importScripts(
      'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js'
    );
    ffmpeg = await loadFreshFfmpeg();

    const now = Date.now().toString();
    inputName = `input_${requestId}_${now}.mp4`;
    outputName = `output_${requestId}_${now}.mp4`;

    stage = 'input-write';
    const inputBytes = base64ToBytes(request.inputBase64);
    ffmpeg.FS('writeFile', inputName, inputBytes);

    const startMs = Number(request.startMs || 0);
    const endMs = Number(request.endMs || 0);
    const args = ['-ss', (startMs / 1000).toFixed(3)];
    if (endMs > startMs) {
      args.push('-to', (endMs / 1000).toFixed(3));
    }
    args.push('-i', inputName);

    const vf = rotationFilter(Number(request.rotationDegrees || 0));
    if (vf) args.push('-vf', vf);

    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-keyint_min',
      '30',
      '-sc_threshold',
      '0',
      '-force_key_frames',
      'expr:gte(t,n_forced*1)',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      outputName
    );

    stage = 'ffmpeg-command';
    await ffmpeg.run(...args);

    stage = 'output-read';
    const outputBytes = ffmpeg.FS('readFile', outputName);
    const outputBuffer = outputBytes.buffer.slice(
      outputBytes.byteOffset,
      outputBytes.byteOffset + outputBytes.byteLength
    );

    self.postMessage(
      {
        requestId,
        ok: true,
        outputBuffer,
      },
      [outputBuffer]
    );
  } catch (error) {
    postFailure(requestId, stage, error, 'FFmpeg trim failed.');
  } finally {
    if (ffmpeg && inputName) {
      try {
        ffmpeg.FS('unlink', inputName);
      } catch (_) {}
    }
    if (ffmpeg && outputName) {
      try {
        ffmpeg.FS('unlink', outputName);
      } catch (_) {}
    }
    self.close();
  }
};
