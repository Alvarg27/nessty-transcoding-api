const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
const { extname, resolve } = require("path");
const fs = require("fs");
const path = require("path");
const TranscoderConfig = require("../config/transcoder.cofig.json");
const createHttpError = require("http-errors");
const { existsSync, mkdirSync, unlink } = fs;
const { Readable } = require("stream");
const tmpDir = require("os").tmpdir();

const streams = [
  {
    bandwidth: "200000",
    resolution: "256x144",
    playlistFile: "144p.m3u8",
    outputOptions: [
      "-b:v",
      "150k",
      "-maxrate",
      "220k",
      "-bufsize",
      "300k",
      "-b:a",
      "64k",
    ],
  },
  {
    bandwidth: "500000",
    resolution: "426x240",
    playlistFile: "240.m3u8",
    outputOptions: [
      "-b:v",
      "400k",
      "-maxrate",
      "456k",
      "-bufsize",
      "600k",
      "-b:a",
      "96k",
    ],
  },
  {
    bandwidth: "800000",
    resolution: "640x360",
    playlistFile: "360p.m3u8",
    outputOptions: [
      "-b:v",
      "800k",
      "-maxrate",
      "856k",
      "-bufsize",
      "1200k",
      "-b:a",
      "96k",
    ],
  },
  {
    bandwidth: "1500000",
    resolution: "1280x720",
    playlistFile: "720p.m3u8",
    outputOptions: [
      "-b:v",
      "2800k",
      "-maxrate",
      "2996k",
      "-bufsize",
      "4200k",
      "-b:a",
      "128k",
    ],
  },
  {
    bandwidth: "3000000",
    resolution: "1920x1080",
    playlistFile: "1080p.m3u8",
    outputOptions: [
      "-b:v",
      "5000k",
      "-maxrate",
      "5350k",
      "-bufsize",
      "7500k",
      "-b:a",
      "192k",
    ],
  },
  {
    bandwidth: "6000000",
    resolution: "2560x1440",
    playlistFile: "1440p.m3u8",
    outputOptions: [
      "-b:v",
      "8000k",
      "-maxrate",
      "8800k",
      "-bufsize",
      "13200k",
      "-b:a",
      "192k",
    ],
  },
  {
    bandwidth: "12000000",
    resolution: "3840x2160",
    playlistFile: "4k.m3u8",
    outputOptions: [
      "-b:v",
      "15000k",
      "-maxrate",
      "16500k",
      "-bufsize",
      "24750k",
      "-b:a",
      "192k",
    ],
  },
];

//////////////////////////////
// GET RESOLUTION
/////////////////////////////
function getVideoDimensions(buffer) {
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

        if (videoStream) {
          resolve({
            width: videoStream.width,
            height: videoStream.height,
          });
        } else {
          reject(new Error("No video stream found"));
        }
      });
  });
}

// CLOUD STORAGE

const { Storage, TransferManager } = require("@google-cloud/storage");
const { v4: uuidv4 } = require("uuid");
const { exec } = require("child_process");
const storage = new Storage({
  keyFilename: "service_key.json",
});
const bucketName = "nessty-files";

const bucket = storage.bucket(bucketName);

exports.transcoderVideo = async (req, res, next) => {
  try {
    if (!req.file) {
      throw createHttpError.BadRequest("Upload a file to begin transcoding");
    }

    const fileId = uuidv4();

    const videoMetadata = await getVideoDimensions(req.file.buffer);

    if (!videoMetadata?.height || videoMetadata?.height < 144) {
      throw createHttpError.BadRequest("Minimum height for a video is 144p");
    }
    if (!videoMetadata?.width || videoMetadata?.width < 144) {
      throw createHttpError.BadRequest("Minimum width for a video is 144p");
    }

    // FILTER STREAMS BY ORIGINAL VIDEO RESOLUTION
    const filteredStreams = streams.filter(
      (x) => videoMetadata.height >= x?.resolution?.split("x")[1]
    );

    for (let i = 0; i < filteredStreams.length; i++) {
      const config = filteredStreams[i];
      await processVideo(req.file.buffer, fileId, config);
    }
    await createMasterPlaylist(filteredStreams, fileId);

    res.send(fileId);
  } catch (error) {
    console.log(`Transcoding failed: `, error);
    next(error);
  }
};
/////////////////////////////
// PROCESS FILE
////////////////////////////

const processVideo = (buffer, fileId, config) => {
  return new Promise((resolve, reject) => {
    const uniqueDir = path.join(tmpDir, uuidv4());
    fs.mkdirSync(uniqueDir);
    const command = ffmpeg({
      source: Readable.from(buffer, { objectMode: false }),
      nolog: false,
    })
      .setFfmpegPath(ffmpegInstaller.path)
      .output(path.join(uniqueDir, config.playlistFile))
      .videoCodec("libx264")
      .audioCodec("aac")
      .size(`${config.resolution}`)
      .outputOptions([...config.outputOptions])
      .on("error", (err) => {
        console.info("error", err);
        reject(err);
      })
      .on("progress", (progress) => {
        console.info("progress", progress);
      })
      .on("end", async () => {
        console.log(`HLS ${config.resolution} segmenting complete`);
        //////////////////////////////
        // UPLOAD TO GOOGLE CLOUD
        //////////////////////////////

        await uploadDirToGCS(uniqueDir, fileId);
        fs.rmSync(uniqueDir, { recursive: true, force: true });
        resolve();
      });
    command.run();
  });
};

/////////////////////////////
// UPLOAD DIR TO GOOGLE CLOUD
////////////////////////////

const uploadDirToGCS = async (directory, fileId) => {
  return new Promise((resolve, reject) => {
    const bucket = storage.bucket("nessty-files");
    fs.readdir(directory, (err, files) => {
      if (err) {
        console.error("Error reading directory:", err);
        reject(err);
      }

      let uploadedFiles = 0;
      files.forEach((file) => {
        const localFilePath = path.join(directory, file);
        const remoteFilePath = `video/transcoded/${fileId}/${file}`;

        bucket
          .upload(localFilePath, { destination: remoteFilePath })
          .then(() => {
            console.log(`Uploaded ${file} to ${remoteFilePath}`);
            uploadedFiles++;
            if (uploadedFiles === files.length) {
              console.log("All files uploaded");
              resolve();
            }
          })
          .catch((err) => {
            reject(err);
          });
      });
    });
  });
};

/////////////////////////////
// GENERATE THE HLS MASTER
////////////////////////////

const createMasterPlaylist = async (filteredStreams, fileId) => {
  return new Promise((resolve, reject) => {
    const uniqueDir = path.join(tmpDir, uuidv4());
    fs.mkdirSync(uniqueDir);
    let masterPlaylistContent = "#EXTM3U\n";

    filteredStreams.forEach((stream) => {
      masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${stream.bandwidth},RESOLUTION=${stream.resolution}\n`;
      masterPlaylistContent += `${stream.playlistFile}\n`;
    });

    const masterPlaylistPath = path.join(uniqueDir, "master.m3u8");
    fs.writeFileSync(masterPlaylistPath, masterPlaylistContent);
    bucket
      .upload(masterPlaylistPath, {
        destination: `video/transcoded/${fileId}/master.m3u8`,
      })
      .then(() => {
        console.log(`Master successfully uploaded`);
        resolve();
      })
      .catch((err) => {
        reject(err);
      });
  });
};
