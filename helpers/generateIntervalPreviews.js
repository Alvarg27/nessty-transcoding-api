const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { Readable, PassThrough } = require("stream");
const { Storage } = require("@google-cloud/storage");

const storage = new Storage({
  keyFilename: "service_key.json",
});
const bucketName = "nessty-files";
const bucket = storage.bucket(bucketName);

function calculateTime(frameRate, frameNumber) {
  const [numerator, denominator] = frameRate.split("/").map(Number);
  const fps = numerator / denominator;
  return (frameNumber / fps).toFixed(3);
}

async function streamFrameToStorage(buffer, remoteFilePath, frameTime) {
  return new Promise((resolve, reject) => {
    const passThroughStream = new PassThrough();
    const fileWriteStream = bucket.file(remoteFilePath).createWriteStream({
      metadata: { contentType: "image/jpeg" },
    });

    fileWriteStream
      .on("finish", () => {
        console.log(`Upload finished for: ${remoteFilePath}`);
        resolve();
      })
      .on("error", (error) => {
        console.error(`Error during upload: ${error.message}`);
        reject(error);
      });

    passThroughStream.pipe(fileWriteStream);

    const ffmpegStream = ffmpeg()
      .input(Readable.from(buffer))
      .setFfmpegPath(ffmpegInstaller.path)
      .outputOptions([`-ss ${frameTime}`, "-vframes 1", "-s 426x240"])
      .outputFormat("image2")
      .on("error", (error) => {
        console.error(`Error during FFmpeg processing: ${error.message}`);
        reject(error);
      })
      .pipe(passThroughStream, { end: true });

    ffmpegStream.on("end", () => {
      console.log(`FFmpeg processing finished for: ${remoteFilePath}`);
    });
  });
}

async function generateVideoPreviews(buffer, fileId, duration, frameRate) {
  const intervalInSeconds = 3;
  const fps = frameRate.split("/").reduce((a, b) => a / b);
  const frameInterval = Math.round(intervalInSeconds * fps);

  for (let frameNumber = 0; ; frameNumber += frameInterval) {
    const frameTime = calculateTime(frameRate, frameNumber);
    const roundedTime = Math.round(parseFloat(frameTime)); // Round to nearest whole number

    // Break the loop if the calculated time exceeds the video duration
    if (roundedTime > duration) break;

    const outputFileName = `preview_${roundedTime}.jpg`;

    try {
      await streamFrameToStorage(
        buffer,
        `video/transcoded/${fileId}/${outputFileName}`,
        frameTime
      );
      console.log(`Processed and uploaded ${outputFileName}`);
    } catch (error) {
      console.error(`Error in processing ${outputFileName}: ${error.message}`);
      // Decide how to handle individual errors - retry, continue, or abort
    }
  }
}
module.exports = generateVideoPreviews;
