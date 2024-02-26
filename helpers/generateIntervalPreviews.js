const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { Readable, PassThrough } = require("stream");
const { Storage } = require("@google-cloud/storage");

const storage = new Storage({
  keyFilename: "service_key.json",
});
const bucketName = "nessty-files";
const bucket = storage.bucket(bucketName);

const generateIntervalPreviews = async (buffer, fileId, duration) => {
  try {
    const interval = 3;
    for (let currentTime = 0; currentTime < duration; currentTime += interval) {
      const outputFileName = `preview_${currentTime}.jpg`;
      await streamFrameToStorage(
        buffer,
        `video/transcoded/${fileId}/${outputFileName}`,
        currentTime
      );
      console.log(`Uploaded ${outputFileName}`);
    }
    console.log("All previews processed and uploaded.");
  } catch (error) {
    console.error("Error in processing and uploading images:", error);
  }
};

function streamFrameToStorage(buffer, remoteFilePath, startTime) {
  return new Promise((resolve, reject) => {
    const adjustedStartTime = startTime === 0 ? 0.01 : startTime;
    const passThroughStream = new PassThrough();
    const fileWriteStream = bucket.file(remoteFilePath).createWriteStream({
      metadata: {
        contentType: "image/jpeg",
      },
    });

    fileWriteStream.on("finish", resolve).on("error", reject);
    passThroughStream.pipe(fileWriteStream);
    ffmpeg({
      source: Readable.from(buffer, { objectMode: false }),
      nolog: false,
    })
      .setFfmpegPath(ffmpegInstaller.path)
      .setStartTime(adjustedStartTime)
      .outputFormat("image2")
      .outputOptions([
        "-frames:v 2",
        "-force_key_frames", // Force keyframes at specified intervals
        "expr:gte(t,n_forced*3)",
        `-vf scale=426x240`,
      ])
      .on("error", reject)
      .pipe(passThroughStream, { end: true });
  });
}

module.exports = generateIntervalPreviews;
