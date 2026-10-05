import type { RequestHandler } from "express";

export const authenticate: RequestHandler = (req, res, next) => {
  const key = process.env.API_KEY;
  if (!key) {
    res.status(503).json({
      error: {
        message: "Proxy API key not configured",
        type: "configuration_error",
      },
    });
    return;
  }
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "auth_error",
      },
    });
    return;
  }
  next();
};

export const authenticateAnthropic: RequestHandler = (req, res, next) => {
  const key = process.env.API_KEY;
  if (!key) {
    res.status(503).json({
      type: "error",
      error: {
        type: "api_error",
        message: "Proxy API key not configured",
      },
    });
    return;
  }
  const valid =
    req.headers.authorization === `Bearer ${key}` ||
    req.headers["x-api-key"] === key;
  if (!valid) {
    res.status(401).json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid API key",
      },
    });
    return;
  }
  next();
};

// Aliases for compatibility
export const auth = authenticate;
export const anthropicAuth = authenticateAnthropic;
