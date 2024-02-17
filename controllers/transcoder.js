const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
const moment = require("moment");
const fs = require("fs");
const path = require("path");
const createHttpError = require("http-errors");
const { Readable } = require("stream");
const tmpDir = require("os").tmpdir();
const { Storage } = require("@google-cloud/storage");
const { v4: uuidv4 } = require("uuid");
const storage = new Storage({
  keyFilename: "service_key.json",
});
const { VideoProduction, VideoSandbox } = require("../models/video");
const bucketName = "nessty-files";
const bucket = storage.bucket(bucketName);

function timeToSeconds(timeString) {
  // Split the time string by colon and dot
  const parts = timeString.split(":");
  const secondsParts = parts[2].split(".");

  // Extract hours, minutes, and seconds
  const hours = parseInt(parts[0]);
  const minutes = parseInt(parts[1]);
  const seconds = parseInt(secondsParts[0]);
  const milliseconds = parseInt(secondsParts[1]);

  // Convert hours and minutes to seconds and add everything together
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 100;
}

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
            duration: videoStream.duration,
          });
        } else {
          reject(new Error("No video stream found"));
        }
      });
  });
}

exports.transcoderVideo = async (req, res, next) => {
  try {
    // RETRIEVE HEADERS
    if (!req.headers["authorization"]) {
      throw createHttpError.Unauthorized();
    }
    const authHeader = req.headers["authorization"];
    const bearerToken = authHeader.split(" ");
    if (bearerToken.length < 2) {
      throw createHttpError.Unauthorized();
    }
    const token = bearerToken[1];

    let environment;
    if (token === process.env.PRODUCTION_SECRET) {
      environment = "PRODUCTION";
    } else if (token === process.env.SANDBOX_SECRET) {
      environment = "DEVELOPMENT";
    } else {
      throw createError.Unauthorized();
    }
    console.log(`Running transcoder on ${environment} mode`);
    const { videoId } = req.params;
    let video;
    if (environment === "PRODUCTION") {
      video = await VideoProduction.findOne({
        _id: videoId,
      });
    } else {
      video = await VideoSandbox.findOne({
        _id: videoId,
      });
    }

    const sandbox = await VideoSandbox.find();
    console.log(sandbox);
    if (!video) {
      throw createHttpError.NotFound("video not found");
    }
    const [videoBuffer] = await bucket
      .file(`video/raw/${video.name}.mp4`)
      .download();

    const videoMetadata = await getVideoDimensions(videoBuffer);

    if (!videoMetadata?.height || videoMetadata?.height < 144) {
      throw createHttpError.BadRequest("Minimum height for a video is 144p");
    }
    if (!videoMetadata?.width || videoMetadata?.width < 144) {
      throw createHttpError.BadRequest("Minimum width for a video is 144p");
    }

    await video.updateOne({
      duration: videoMetadata.duration,
    });

    // FILTER STREAMS BY ORIGINAL VIDEO RESOLUTION
    const filteredStreams = streams.filter(
      (x) => videoMetadata.height >= x?.resolution?.split("x")[1]
    );

    await processVideo(videoBuffer, video.name, filteredStreams, video);
    res.send();
  } catch (error) {
    console.log(`Transcoding failed: `, error);
    next(error);
  }
};
/////////////////////////////
// PROCESS FILE
////////////////////////////

const processVideo = (buffer, fileId, filteredStreams, video) => {
  return new Promise((resolve, reject) => {
    const uniqueDir = path.join(tmpDir, uuidv4());
    fs.mkdirSync(uniqueDir);
    const command = ffmpeg({
      source: Readable.from(buffer, { objectMode: false }),
      nolog: false,
    }).setFfmpegPath(ffmpegInstaller.path);
    for (let i = 0; i < filteredStreams.length; i++) {
      const config = filteredStreams[i];
      command
        .output(path.join(uniqueDir, config.playlistFile))
        .videoCodec("libx264")
        .audioCodec("aac")
        .size(`${config.resolution}`)
        .autopad()
        .outputOptions([...config.outputOptions])
        .on("error", (err) => {
          console.info("error", err);
          reject(err);
        });
    }
    command
      .on("start", async () => {
        await video.updateOne({
          status: "processing",
          processing_start: moment.utc().toDate(),
          updated: moment.utc().toDate(),
        });
        resolve();
      })
      .on("progress", async (progress) => {
        await video.updateOne({
          status: "processing",
          processing_progress: timeToSeconds(progress.timemark),
          updated: moment.utc().toDate(),
        });
      })
      .on("end", async () => {
        console.log(`Processing complete`);
        await video.updateOne({
          status: "unpublished",
          processing_end: moment.utc().toDate(),
          updated: moment.utc().toDate(),
        });
        //////////////////////////////
        // UPLOAD TO GOOGLE CLOUD
        //////////////////////////////
        await createMasterPlaylist(filteredStreams, fileId);
        await uploadDirToGCS(uniqueDir, fileId);
        console.log("[OK] Files successfully uploaded");
        fs.rmSync(uniqueDir, { recursive: true, force: true });
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
            uploadedFiles++;
            if (uploadedFiles === files.length) {
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
