// ==========================================================================
// Google Drive helpers
// Rewrites Drive share links into URLs a <video>/<audio> element can stream
// ==========================================================================

import is from './is';
import { format } from './strings';

// Drive file IDs are URL-safe base64-ish strings
const idPatterns = [
  // https://drive.google.com/file/d/{id}/view (also /preview, /edit, etc)
  /^https?:\/\/(?:drive|docs)\.google\.com\/file\/d\/([\w-]{10,})/,
  // https://drive.google.com/open?id={id}, https://drive.google.com/uc?id={id}&export=download
  /^https?:\/\/(?:drive|docs)\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]{10,})/,
  // https://drive.usercontent.google.com/download?id={id}
  /^https?:\/\/drive\.usercontent\.google\.com\/(?:download|uc)\?(?:.*&)?id=([\w-]{10,})/,
];

/**
 * Get a Google Drive file ID from a share/download URL
 * @param {string} url
 * @returns {string|null}
 */
export function getGoogleDriveId(url) {
  if (!is.string(url)) {
    return null;
  }

  for (const pattern of idPatterns) {
    const match = url.trim().match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Convert a Google Drive URL into a streamable media URL
 * Non-Drive URLs are returned untouched
 * @param {string} url
 * @param {object} config - Player config
 * @returns {string}
 */
export function getGoogleDriveStreamUrl(url, config) {
  const { googleDrive = {}, urls = {} } = config || {};

  if (googleDrive.enabled === false) {
    return url;
  }

  const id = getGoogleDriveId(url);
  if (!id) {
    return url;
  }

  const templates = urls.googleDrive || {};

  // The Drive API supports range requests and CORS, so it's the most reliable option
  if (!is.empty(googleDrive.apiKey) && templates.api) {
    return format(templates.api, encodeURIComponent(id), encodeURIComponent(googleDrive.apiKey));
  }

  // Fall back to the public download endpoint (confirm=t skips the virus scan page for large files)
  return templates.download ? format(templates.download, encodeURIComponent(id)) : url;
}

/**
 * Rewrite the src of a media element and its <source> children
 * @param {HTMLMediaElement} media
 * @param {object} config - Player config
 * @returns {boolean} Whether anything was changed
 */
export function rewriteGoogleDriveSources(media, config) {
  if (!is.element(media)) {
    return false;
  }

  let changed = false;

  [media, ...media.querySelectorAll('source')].forEach((element) => {
    const src = element.getAttribute('src');
    const rewritten = getGoogleDriveStreamUrl(src, config);

    if (src && rewritten !== src) {
      element.setAttribute('src', rewritten);
      changed = true;
    }
  });

  return changed;
}

export default { getGoogleDriveId, getGoogleDriveStreamUrl, rewriteGoogleDriveSources };
