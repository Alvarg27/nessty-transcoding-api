const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { Readable } = require("stream");
const fs = require("fs-extra");
const path = require("path");
const uploadDirToGCS = require("./uploadDirToGCS");
const tmpDir = require("os").tmpdir();
const { v4: uuidv4 } = require("uuid");

function calculateTime(frameRate, frameNumber) {
  const [numerator, denominator] = frameRate.split("/").map(Number);
  const fps = numerator / denominator;
  return (frameNumber / fps).toFixed(3);
}

async function generateVideoPreviews(
  buffer,
  fileId,
  duration,
  frameRate,
  cloudDirectory,
  video
) {
  const intervalInSeconds = 3;
  const fps = frameRate.split("/").reduce((a, b) => a / b);
  const frameInterval = Math.round(intervalInSeconds * fps);
  const uniqueDir = path.join(tmpDir, uuidv4());
  fs.mkdirSync(uniqueDir);

  const ffmpegCommand = ffmpeg({ source: Readable.from(buffer) }).setFfmpegPath(
    ffmpegInstaller.path
  );

  for (let frameNumber = 0; ; frameNumber += frameInterval) {
    const frameTime = calculateTime(frameRate, frameNumber);
    const roundedTime = Math.round(parseFloat(frameTime));

    if (roundedTime > duration) break;
    const outputFileName = `preview_${roundedTime}.jpg`;
    ffmpegCommand
      .output(path.join(uniqueDir, outputFileName))
      .outputOptions([`-ss ${frameTime}`, "-vframes 1", "-s 426x240"])
      .noAudio();
  }
  try {
    await new Promise((resolve, reject) => {
      ffmpegCommand
        .on("end", () => {
          console.log("All previews generated");
          resolve();
        })
        .on("error", (err) => {
          console.error(`Error during FFmpeg processing: ${err.message}`);
          reject(err);
        })
        .run();
    });

    // Upload the directory using your existing function
    await uploadDirToGCS(uniqueDir, fileId);
    console.log("All previews uploaded");
  } catch (error) {
    console.error(`Error during processing: ${error.message}`);
  } finally {
    // REMOVE LOCAL DIRECTORY
    fs.rmSync(uniqueDir, { recursive: true, force: true });
  }
}

module.exports = generateVideoPreviews;
