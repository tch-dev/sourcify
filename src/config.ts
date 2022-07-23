/* eslint-disable no-useless-escape */

import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, "..", "environments/.env") });

export default {
    monitor: {
        port: process.env.MONITOR_PORT || 80
    },
    server: {
        port: process.env.SERVER_PORT || 5000,
        url: process.env.SERVER_URL || "http://localhost:5000",
        maxFileSize: 30 * 1024 * 1024 // 30 MB
    },
    localchain: {
        port: process.env.LOCALCHAIN_PORT || 8545,
        url: process.env.LOCALCHAIN_URL,
    },
    repository: {
        port: process.env.REPOSITORY_PORT || 80,
        path: process.env.MOCK_REPOSITORY || path.resolve(__dirname, process.env.REPOSITORY_PATH!) || path.resolve(__dirname, './repository'),
        dbPath: process.env.MOCK_DATABASE || path.resolve(__dirname, process.env.DATABASE_PATH!) || path.resolve(__dirname, './database')
    },
    testing: process.env.TESTING || false,
    tag: process.env.TAG || 'latest',
    logging: {
        dir: process.env.LOGGING_DIR || 'logs',
        level: process.env.LOGGING_LEVEL || 'debug'
    },
    session: {
        secret: process.env.SESSION_SECRET || "session top secret",
        maxAge: parseInt(process.env.SESSION_MAX_AGE, 10) || (12 * 60 * 60 * 1000), // 12 hrs in millis
        secure: process.env.NODE_ENV === "production" && process.env.TESTING !== "true" // Set Secure in the Set-Cookie header i.e. require https
    },
    corsAllowedOrigins: [
        /^https?:\/\/(?:.+\.)?sourcify.dev$/, // sourcify.dev and subdomains
        /^https?:\/\/(?:.+\.)?trustcontract.dev$/, // trustcontract.dev and subdomains
        /^https?:\/\/(?:.+\.)?trustcontract.dev.link$/, // trustcontract.dev.link and subdomains
        /^https?:\/\/(?:.+\.)?ipfs.dweb.link$/, // dweb links used by Brave browser etc.
        process.env.NODE_ENV === "development" && /^https?:\/\/localhost(?::\d+)?$/, // localhost on any port
    ]
}
