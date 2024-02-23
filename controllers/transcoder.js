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
    bandwidth: "500000", // 240p
    resolution: "426x240", // 240p
    playlistFile: "240p.m3u8",
    outputOptions: [
      "-b:v",
      "400k",
      "-maxrate",
      "500k",
      "-bufsize",
      "1000k",
      "-b:a",
      "64k",
    ],
  },
  {
    bandwidth: "1000000", // 360p
    resolution: "640x360", // 360p
    playlistFile: "360p.m3u8",
    outputOptions: [
      "-b:v",
      "800k",
      "-maxrate",
      "1000k",
      "-bufsize",
      "2000k",
      "-b:a",
      "96k",
    ],
  },
  {
    bandwidth: "3000000", // 720p
    resolution: "1280x720", // 720p
    playlistFile: "720p.m3u8",
    outputOptions: [
      "-b:v",
      "2500k",
      "-maxrate",
      "3000k",
      "-bufsize",
      "6000k",
      "-b:a",
      "128k",
    ],
  },
  {
    bandwidth: "6000000", // 1080p
    resolution: "1920x1080", // 1080p
    playlistFile: "1080p.m3u8",
    outputOptions: [
      "-b:v",
      "5000k",
      "-maxrate",
      "6000k",
      "-bufsize",
      "12000k",
      "-b:a",
      "192k",
    ],
  },
  {
    bandwidth: "12000000", // 1440p
    resolution: "2560x1440", // 1440p
    playlistFile: "1440p.m3u8",
    outputOptions: [
      "-b:v",
      "10000k",
      "-maxrate",
      "12000k",
      "-bufsize",
      "24000k",
      "-b:a",
      "192k",
    ],
  },
  {
    bandwidth: "30000000", // 4K
    resolution: "3840x2160", // 4K
    playlistFile: "4k.m3u8",
    outputOptions: [
      "-b:v",
      "25000k",
      "-maxrate",
      "30000k",
      "-bufsize",
      "60000k",
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
            bitrate: videoStream.bit_rate,
            codec: videoStream.codec_name,
            avg_frame_rate: videoStream.avg_frame_rate,
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

    if (!video) {
      throw createHttpError.NotFound("video not found");
    }
    if (video?.status?.canceled) {
      throw createHttpError.NotFound("video not found");
    }
    const handleExtension = (mimetype) => {
      if (mimetype === "video/mp4") {
        return "mp4";
      } else if (mimetype === "video/quicktime") {
        return "mov";
      } else {
        throw createHttpError.BadRequest(
          "Only .mp4 and .mov videos are accepted"
        );
      }
    };
    const extension = handleExtension(video?.type);

    const [videoBuffer] = await bucket
      .file(`video/raw/${video.name}.${extension}`)
      .download();

    await streamThumbnailToGCP(videoBuffer, video.name);
    const videoMetadata = await getVideoDimensions(videoBuffer);

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

    await video.updateOne({
      duration: videoMetadata.duration,
      status: "pending_processing",
      streams: filteredStreams.map((x) => x.resolution),
      input_dimensions: {
        height: videoMetadata.height,
        width: videoMetadata.width,
      },
      input_bitrate: videoMetadata.bit_rate,
      input_codec: videoMetadata.codec,
      input_avg_frame_rate: videoMetadata.avg_frame_rate,
    });

    await processVideo(
      videoBuffer,
      video.name,
      filteredStreams,
      video,

      environment
    );
    res.send();
  } catch (error) {
    console.log(`Transcoding failed: `, error);
    next(error);
  }
};
/////////////////////////////
// PROCESS FILE
////////////////////////////

const processVideo = (buffer, fileId, filteredStreams, video, environment) => {
  return new Promise((resolve, reject) => {
    const uniqueDir = path.join(tmpDir, uuidv4());
    fs.mkdirSync(uniqueDir);

    const command = ffmpeg({
      source: Readable.from(buffer, { objectMode: false }),
      nolog: false,
    }).setFfmpegPath(ffmpegInstaller.path);

    // CANCELATION INTERVAL
    let canceled = false;
    let intervalId = setInterval(async () => {
      let currentVideo;
      if (environment === "PRODUCTION") {
        currentVideo = await VideoProduction.findOne({
          _id: video?._id,
        });
      } else {
        currentVideo = await VideoSandbox.findOne({
          _id: video?._id,
        });
      }
      if (!currentVideo || currentVideo?.status === "canceled") {
        command.kill("SIGTERM"); // or just command.kill() for default SIGKILL
        clearInterval(intervalId);
        console.log("FFmpeg process terminated due to video cancellation");
        canceled = true;
      }
    }, 2000); // Check every 5 seconds

    for (let i = 0; i < filteredStreams.length; i++) {
      const config = filteredStreams[i];
      command
        .output(path.join(uniqueDir, config.playlistFile))
        .videoCodec("libx264")
        .audioCodec("aac")
        .size(`${config.resolution}`)
        .autopad()
        .outputOptions([
          ...config.outputOptions,
          "-hls_list_size",
          "0",
          "-hls_time",
          "2",
          "-r", // Set frame rate
          "30", // Assuming 30 fps
          "-force_key_frames", // Force keyframes at specified intervals
          "expr:gte(t,n_forced*2)", // Force a keyframe every 2 seconds
          "-sc_threshold",
          "0", // Disable scene cut detection
        ]);
    }

    // Generating Thumbnail
    command
      .output(path.join(uniqueDir, "thumbnail.png"))
      .frames(1)
      .noAudio()
      .seek("00:00:03");

    command
      .on("start", async (command) => {
        console.log(command);
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
        //////////////////////////////
        // UPLOAD TO GOOGLE CLOUD
        //////////////////////////////
        await createMasterPlaylist(filteredStreams, fileId, uniqueDir);
        await uploadDirToGCS(uniqueDir, fileId);
        // REMOVE LOCAL DIRECTORY
        fs.rmSync(uniqueDir, { recursive: true, force: true });
        // REMOVE RAW FILES
        await bucket.deleteFiles({
          prefix: `video/raw/${video.name}.mp4`,
        });
        await bucket.deleteFiles({
          prefix: `video/raw/${video.name}.png`,
        });
        console.log(`Processing complete`);
        await video.updateOne({
          status: "complete",
          processing_end: moment.utc().toDate(),
          updated: moment.utc().toDate(),
        });
        console.log("[OK] Files successfully uploaded");
      })
      .on("error", async (err) => {
        if (!canceled) {
          console.info("error", err);
          video.updateOne({
            status: "failed",
            processing_end: moment.utc().toDate(),
            updated: moment.utc().toDate(),
          });
        }
        // REMOVE LOCAL DIRECTORY
        fs.rmSync(uniqueDir, { recursive: true, force: true });
        // REMOVE FILES FROM CLOUD STORAGE
        await bucket.deleteFiles({
          prefix: `video/transcoded/${video.name}`,
        });
        await bucket.deleteFiles({
          prefix: `video/raw/${video.name}.mp4`,
        });
        await bucket.deleteFiles({
          prefix: `video/raw/${video.name}.png`,
        });
      });

    command.run();
  });
};

/////////////////////////////
// UPLOAD DIR TO GOOGLE CLOUD
////////////////////////////

const uploadDirToGCS = async (directory, fileId) => {
  return new Promise((resolve, reject) => {
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

const createMasterPlaylist = async (filteredStreams, fileId, uniqueDir) => {
  return new Promise((resolve, reject) => {
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

/////////////////////////////
// GENERATE INITIAL THUMBNAIL
////////////////////////////

const streamThumbnailToGCP = async (buffer, fileId) => {
  return new Promise((resolve, reject) => {
    const file = bucket.file(`video/raw/${fileId}.png`);
    const thumbnailStream = file.createWriteStream();

    ffmpeg({
      source: Readable.from(buffer, { objectMode: false }),
      nolog: false,
    })
      .setFfmpegPath(ffmpegInstaller.path)
      .inputFormat("mp4") // or the appropriate format of your video
      .seek("00:00:03")
      .outputOptions(["-frames:v 1", `-vf scale=426x240`])
      .outputFormat("image2pipe")
      .output(thumbnailStream)
      .on("end", () => {
        console.log("Thumbnail streamed to GCP");
        resolve();
      })
      .on("error", (err) => {
        console.error("Error streaming thumbnail:", err);
        reject(err);
      })
      .run();
  });
};
