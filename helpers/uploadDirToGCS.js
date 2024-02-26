const fs = require("fs");
const path = require("path");
const { Storage } = require("@google-cloud/storage");
const storage = new Storage({
  keyFilename: "service_key.json",
});
const maxConcurrentUploads = 5;
const { promisify } = require("util");
const readdir = promisify(fs.readdir);
const pipeline = promisify(require("stream").pipeline);

const bucketName = "nessty-files";
const bucket = storage.bucket(bucketName);

/////////////////////////////
// UPLOAD DIR TO GOOGLE CLOUD
////////////////////////////

const uploadDirToGCS = async (localDirectory, fileId, errorCleanup) => {
  try {
    const files = await readdir(localDirectory);
    const uploadTasks = files.map((file) => {
      const localFilePath = path.join(localDirectory, file);
      const remoteFilePath = `video/transcoded/${fileId}/${file}`;
      return () => uploadFileWithRetry(localFilePath, remoteFilePath);
    });
    const results = await manageConcurrency(uploadTasks);
    const failedUploads = results.filter((r) => r.status === "rejected");

    if (failedUploads.length) {
      console.error(
        "Some files failed to upload:",
        failedUploads.map((f) => f.reason)
      );
      throw new Error(`Failed to upload one or more files`);
    }

    console.log("All files in the directory have been processed.");
  } catch (err) {
    console.error("Error uploading directory:", err);
    // REMOVE LOCAL DIRECTORY
    fs.rmSync(localDirectory, { recursive: true, force: true });
    if (errorCleanup) {
      errorCleanup();
    }
  }
};

module.exports = uploadDirToGCS;

/////////////////////////////
// UPLOAD FILE WITH RETRY LOGIC
////////////////////////////
async function uploadFileWithRetry(
  localFilePath,
  remoteFilePath,
  maxRetries = 5
) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pipeline(
        fs.createReadStream(localFilePath),
        bucket.file(remoteFilePath).createWriteStream({
          resumable: true,
          validation: "crc32c",
        })
      );
      console.log(
        `Upload successful: ${localFilePath} to ${remoteFilePath} (Attempt ${attempt})`
      );
      return;
    } catch (err) {
      lastError = err;
      console.error(
        `Attempt ${attempt} failed to upload ${localFilePath}: ${err}`
      );
    }
  }

  throw new Error(
    `Failed to upload ${localFilePath} after ${maxRetries} attempts: ${lastError.message}`
  );
}
//////////////////////////////
// MANAGE CONCURRENT UPLOADS
//////////////////////////////
async function manageConcurrency(tasks) {
  const executing = new Set();
  const results = [];

  for (const task of tasks) {
    const executeTask = task().then(() => executing.delete(executeTask));
    executing.add(executeTask);

    if (executing.size >= maxConcurrentUploads) {
      await Promise.race([...executing]);
    }

    results.push(executeTask);
  }

  return Promise.allSettled(results);
}
