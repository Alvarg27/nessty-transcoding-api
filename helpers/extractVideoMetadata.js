const ffmpeg = require("fluent-ffmpeg");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
const { Readable } = require("stream");

const extractVideoMetadata = async (buffer) => {
  return new Promise((resolve, reject) => {
    ffmpeg({
      source: Readable.from(buffer, { objectMode: false }),
      nolog: false,
    })
      .setFfprobePath(ffprobeInstaller.path)
      .ffprobe((err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        const videoStream = metadata.streams.find(
          (s) => s.codec_type === "video"
        );

        const audioStream = metadata.streams.find(
          (stream) => stream.codec_type === "audio"
        );

        if (videoStream) {
          resolve({
            width: videoStream.width,
            height: videoStream.height,
            duration: videoStream.duration,
            bitrate: videoStream.bit_rate,
            codec: videoStream.codec_name,
            avg_frame_rate: videoStream.avg_frame_rate,
            audio: audioStream !== undefined,
          });
        } else {
          reject(new Error("No video stream found"));
        }
      });
  });
};
module.exports = extractVideoMetadata;
