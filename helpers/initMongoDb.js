require("dotenv").config();
const mongoose = require("mongoose");

// Define the URIs for your two MongoDB instances
const dbURI1 = process.env.PRODUCTION_MONGO_URI;
const dbURI2 = process.env.SANDBOX_MONGO_URI;
// Create separate connections
const connection1 = mongoose.createConnection(dbURI1, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

connection1.on(
  "error",
  console.error.bind(console, "[PRODUCTION] Mongo DB error: ")
);
connection1.once("open", () => {
  console.log("[PRODUCTION] Mongo DB connected");
});

const connection2 = mongoose.createConnection(dbURI2, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
connection2.on(
  "error",
  console.error.bind(console, "[SANDBOX] Mongo DB error: ")
);
connection2.once("open", () => {
  console.log("[SANDBOX] Mongo DB connected");
});

module.exports = { connection1, connection2 };
