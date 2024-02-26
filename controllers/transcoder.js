const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
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
const speech = require("@google-cloud/speech");
const uploadDirToGCS = require("../helpers/uploadDirToGCS");
const generatePreviewImages = require("../helpers/generatePreviewImages");
const extractVideoMetadata = require("../helpers/extractVideoMetadata");
const client = new speech.SpeechClient({ keyFilename: "service_key.json" });

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

    const videoMetadata = await extractVideoMetadata(videoBuffer);

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

    // EXTRACT ASPECT RATIO

    const aspectRatio = videoMetadata?.width / videoMetadata?.height;

    generatePreviewImages(
      videoBuffer,
      video.name,
      videoMetadata.avg_frame_rate
    );

    // UPDATE VIDEO
    await video.updateOne({
      duration: videoMetadata.duration,
      status: "pending_processing",
      streams: filteredStreams.map((x) => x.resolution),
      aspect_ratio: aspectRatio,
      input_dimensions: {
        height: videoMetadata.height,
        width: videoMetadata.width,
      },
      input_bitrate: videoMetadata.bit_rate,
      input_codec: videoMetadata.codec,
      input_avg_frame_rate: videoMetadata.avg_frame_rate,
    });

    if (videoMetadata?.audio) {
      await extractAudioAndUpload(videoBuffer, video.name);
      transcribeAudio(video.name);
    }

    await processVideo(
      videoBuffer,
      video.name,
      filteredStreams,
      video,
      environment,
      aspectRatio
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

const processVideo = (
  buffer,
  fileId,
  filteredStreams,
  video,
  environment,
  aspectRatio
) => {
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
      const targetHeight = parseInt(config.resolution.split("x")[1]);
      const targetWidth = Math.round(targetHeight * aspectRatio);

      command
        .output(path.join(uniqueDir, config.playlistFile))
        .videoCodec("libx264")
        .audioCodec("aac")
        .size(`${targetWidth}x${targetHeight}`) // Set new resolution
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
      .size(`${Math.round(720 * aspectRatio)}x${720}`)
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
        await uploadDirToGCS(uniqueDir, fileId, uniqueDir);
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

///////////////////////////////
// EXTRACT AUDIO
//////////////////////////////

const extractAudioAndUpload = async (buffer, fileId) => {
  const uniqueDir = path.join(tmpDir, uuidv4());
  fs.mkdirSync(uniqueDir);
  const file = "audio.wav";
  const localFilePath = path.join(uniqueDir, file);
  const remoteFilePath = `video/transcoded/${fileId}/${file}`;
  return new Promise((resolve, reject) => {
    ffmpeg({
      source: Readable.from(buffer, { objectMode: false }),
      nolog: false,
    })
      .setFfmpegPath(ffmpegInstaller.path)
      .audioChannels(1) // Set audio to mono
      .audioFrequency(16000) // Set sample rate to 16000 Hz
      .audioCodec("pcm_s16le") // Linear PCM codec
      .format("wav")
      .output(localFilePath)
      .on("end", async () => {
        bucket
          .upload(localFilePath, {
            destination: remoteFilePath,
          })
          .then(() => {
            console.log(`Audio successfully uploaded`);
            fs.rmSync(uniqueDir, { recursive: true, force: true });
            resolve();
          })
          .catch((err) => {
            reject(err);
          });
      })
      .on("error", (err) => {
        reject(err);
      })
      .run();
  });
};

///////////////////////////////////
// TRANSCRIBE AUDIO
///////////////////////////////////

async function transcribeAudio(fileId, environment) {
  try {
    const request = {
      config: {
        languageCode: "es-MX",
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true, // Enable word-level time offsets
        alternativeLanguageCodes: ["es-MX", "en-US"],
        model: "latest_long",
      },
      audio: {
        uri: `gs://nessty-files/video/transcoded/${fileId}/audio.wav`,
      },
    };
    const [operation] = await client.longRunningRecognize(request);
    const [response] = await operation.promise();
    console.log("[SUCCESS] Transcription created");
    let video;
    if (environment === "PRODUCTION") {
      video = await VideoProduction.findOne({
        name: fileId,
      });
    } else {
      video = await VideoSandbox.findOne({
        name: fileId,
      });
    }
    if (video && video.status !== "failed" && video.status !== "failed") {
      const transcriptionFileName = `video/transcoded/${fileId}/transcription.json`;

      const result = processSpeechToTextResponse(response);

      const transcriptionData = JSON.stringify(result);

      const file = bucket.file(transcriptionFileName);

      // You can either use a stream or directly upload the content
      const stream = file.createWriteStream({
        metadata: {
          contentType: "application/json",
        },
      });

      stream.on("error", (err) => {
        console.error("Error uploading transcription:", err);
      });

      stream.on("finish", async () => {
        await video.updateOne({
          transcription: true,
          updated: moment().utc().toDate(),
        });
        console.log("Transcription uploaded successfully.");
      });

      stream.end(transcriptionData);
    }
  } catch (error) {
    console.error(error);
  }
}

const parseTime = (timeObj) => {
  if (typeof timeObj === "string") {
    return parseFloat(timeObj.replace("s", ""));
  } else if (typeof timeObj === "object" && timeObj.seconds) {
    return parseFloat(timeObj.seconds) + (timeObj.nanos || 0) / 1e9;
  }
  return 0;
};

const processSpeechToTextResponse = (response) => {
  const wordsWithTimestamps = [];

  response.results.forEach((result) => {
    result.alternatives[0].words.forEach((wordInfo) => {
      wordsWithTimestamps.push({
        word: wordInfo.word,
        startTime: parseTime(wordInfo.startTime),
        endTime: parseTime(wordInfo.endTime),
      });
    });
  });

  return wordsWithTimestamps;
};
