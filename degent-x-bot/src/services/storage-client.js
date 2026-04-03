const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../lib/logger');

let s3 = null;

function getS3() {
  if (!s3 && config.storage.accessKey) {
    const s3Config = {
      region: config.storage.region,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
    };
    if (config.storage.endpoint) {
      s3Config.endpoint = config.storage.endpoint;
      s3Config.forcePathStyle = true;
    }
    s3 = new S3Client(s3Config);
    logger.info('S3/R2 client initialized');
  }
  return s3;
}

async function uploadFile(buffer, mimeType, prefix = 'media') {
  const client = getS3();
  if (!client) {
    logger.warn('S3 not configured, skipping upload');
    return null;
  }

  const ext = mimeType.split('/')[1] || 'bin';
  const key = `${prefix}/${uuidv4()}.${ext}`;

  try {
    await client.send(new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }));

    // Construct URL
    const baseUrl = config.storage.endpoint
      ? `${config.storage.endpoint}/${config.storage.bucket}`
      : `https://${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com`;
    const url = `${baseUrl}/${key}`;

    logger.info({ key, url }, 'File uploaded to S3/R2');
    return url;
  } catch (err) {
    logger.error({ err, key }, 'Failed to upload file');
    throw err;
  }
}

module.exports = { getS3, uploadFile };
