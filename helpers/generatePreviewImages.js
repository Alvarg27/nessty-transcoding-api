const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const tmpDir = require("os").tmpdir();
const { v4: uuidv4 } = require("uuid");
const uploadDirToGCS = require("../helpers/uploadDirToGCS");

const generatePreviewImages = async (buffer, fileId, frameRate) => {
  return new Promise((resolve, reject) => {
    const uniqueDir = path.join(tmpDir, uuidv4());
    try {
      fs.mkdirSync(uniqueDir);
    } catch (error) {
      return reject(error);
    }

    const intervalInSeconds = 3; // Interval for frame selection
    const frameRateNumber = parseFloat(eval(frameRate)); // Convert frame rate to number if necessary
    const frameInterval = Math.round(frameRateNumber * intervalInSeconds); //

    // Select filter to pick one frame every frameInterval frames
    const selectFilter = `select='not(mod(n,${frameInterval}))',setpts=N/FRAME_RATE/TB`;
    // Scale filter to set max height to 188px
    const scaleFilter = "scale=-1:188";
    const command = ffmpeg()
      .setFfmpegPath(ffmpegInstaller.path)
      .input(Readable.from(buffer, { objectMode: false }))
      .inputOptions("-copyts") // Preserve timestamps
      .outputOptions(["-vf", `${selectFilter},${scaleFilter}`, "-vsync", "vfr"])
      .output(path.join(uniqueDir, "keyframe_%d.jpg"))
      .noAudio();

    command
      .on("start", (commandLine) => {
        console.log(commandLine);
        console.log("[OK] Preview generation started");
      })
      .on("end", async () => {
        try {
          await uploadDirToGCS(uniqueDir, fileId, uniqueDir);
          fs.rmSync(uniqueDir, { recursive: true, force: true });
          console.log(
            "[OK] Preview generation ended and previews successfully uploaded"
          );
          resolve();
        } catch (uploadError) {
          reject(uploadError);
        }
      })
      .on("error", (err) => {
        console.error("Error during preview generation:", err);
        try {
          fs.rmSync(uniqueDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.error("Error during cleanup:", cleanupError);
        }
        reject(err);
      });

    command.run();
  });
};

module.exports = generatePreviewImages;
