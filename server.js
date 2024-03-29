const express = require("express");
require("dotenv").config();
const morgan = require("morgan");
const cors = require("cors");
require("./helpers/initMongoDb");
const videoRoute = require("./routes/video");
const createHttpError = require("http-errors");
const app = express();

// RATE LIMITER
//const limiter = rateLimit({
//  windowMs: 15 * 60 * 1000, // 15 minutes
//  max: 1000, // Limit each IP to 1000 requests per `window` (here, per 15 //minutes)
//  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
//  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
//});

// APP

//app.use(limiter);
app.use(
  cors({
    origin: "*",
    preflightContinue: true,
    methods: ["GET", "POST", "DELETE", "UPDATE", "PUT", "PATCH"],
  })
);
app.use(express.json());

// MAIN ROUTES
app.use(morgan("dev"));
app.use(express.json());
app.use("/video", videoRoute);
app.use("/health", (req, res, next) => {
  res.send();
});

// 404 HANDLER

app.use(async (req, res, next) => {
  next(createHttpError.NotFound());
});

// ERROR HANDLER

app.use((err, req, res, next) => {
  if (err.code === "ERR_JWT_EXPIRED") {
    res.status(401);
    res.send({
      error: {
        status: 401,
        message: "ERR_JWT_EXPIRED",
      },
    });
  } else {
    res.status(err.status || 500);
    res.send({
      error: {
        status: err.status || 500,
        message: err.message,
      },
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`App listening on http://localhost:${port}`);
});
