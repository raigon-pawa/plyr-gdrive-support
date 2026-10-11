// ==========================================================================
// Google Drive chunked streaming
// Fetches a Drive file in small byte ranges, remuxes it to fragmented MP4 with
// mp4box.js and feeds it to Media Source Extensions, so only what's needed to
// stay a little ahead of the playhead is downloaded
// ==========================================================================

import { getGoogleDriveId, getGoogleDriveStreamUrl } from '../utils/google-drive';
import is from '../utils/is';
import loadScript from '../utils/load-script';
import { format } from '../utils/strings';

// Seconds of media per segment handed to the SourceBuffer
const SEGMENT_DURATION = 2;
const RETRIES = 3;

function getMediaSource() {
  // Safari on iOS 17.1+ only exposes ManagedMediaSource
  return window.ManagedMediaSource || window.MediaSource;
}

// Regular (non-fragmented or fragmented) MP4/MOV files start with an ftyp box
function isMp4(buffer) {
  const bytes = new Uint8Array(buffer, 4, 4);
  return String.fromCharCode(...bytes) === 'ftyp';
}

function isAbort(error) {
  return error && error.name === 'AbortError';
}

class GoogleDriveStream {
  /**
   * Create a chunked stream if it applies to these sources, otherwise null
   * @param {Plyr} player
   * @param {Array<{src: string}>} sources
   */
  static create(player, sources) {
    const { googleDrive } = player.config;

    if (!googleDrive || googleDrive.enabled === false || !googleDrive.chunked) {
      return null;
    }

    const entry = (sources || []).find((s) => s && getGoogleDriveId(s.src));
    if (!entry) {
      return null;
    }

    // Byte ranges can only be read from the page through the Drive API (the download endpoint has no CORS)
    if (is.empty(googleDrive.apiKey)) {
      player.debug.warn('Google Drive chunked streaming needs googleDrive.apiKey, using progressive download');
      return null;
    }

    if (!GoogleDriveStream.supported) {
      player.debug.warn('Media Source Extensions not supported, using progressive download');
      return null;
    }

    return new GoogleDriveStream(player, {
      id: getGoogleDriveId(entry.src),
      url: getGoogleDriveStreamUrl(entry.src, player.config),
    });
  }

  static get supported() {
    const MediaSource = getMediaSource();
    return Boolean(MediaSource && is.function(MediaSource.isTypeSupported) && is.function(window.fetch));
  }

  /**
   * @param {Plyr} player
   * @param {{url: string, id?: string}} options - url must support range requests and CORS
   */
  constructor(player, { url, id = null }) {
    const { googleDrive } = player.config;

    this.player = player;
    this.media = player.media;
    this.url = url;
    this.id = id;
    this.chunkSize = Math.max(256 * 1024, Number(googleDrive.chunkSize) || 2 * 1024 * 1024);
    this.bufferAhead = Math.max(5, Number(googleDrive.bufferAhead) || 30);
    this.bufferBehind = Math.max(5, Number(googleDrive.bufferBehind) || 30);

    this.size = 0;
    this.nextOffset = 0;
    this.tracks = [];
    this.file = null;
    this.ready = false;
    this.fetching = false;
    this.flushed = false;
    this.destroyed = false;
    this.generation = 0;
    this.controller = null;
    this.objectUrl = null;
    this.mediaSource = null;

    // Exposed for debugging / demo UI
    this.stats = { mode: 'starting', requests: 0, bytes: 0, size: 0 };

    this.onSeeking = this.onSeeking.bind(this);
    this.onTimeUpdate = this.onTimeUpdate.bind(this);
  }

  async start() {
    try {
      await this.loadLibrary();

      const head = await this.fetchRange(0, this.chunkSize - 1);
      if (this.destroyed) {
        return;
      }
      if (!isMp4(head.buffer)) {
        this.fallback('not an MP4 file');
        return;
      }

      this.size = head.total || (await this.fetchSize());
      this.stats.size = this.size;
      if (!this.size) {
        this.fallback('could not determine the file size');
        return;
      }

      await this.attach();
      if (this.destroyed) {
        return;
      }

      this.createFile();
      this.stats.mode = 'chunked';
      this.appendToFile(head.buffer, 0);
      this.pump();
    } catch (error) {
      this.fail(error);
    }
  }

  async loadLibrary() {
    if (!window.MP4Box) {
      await loadScript(this.player.config.urls.googleDrive.mp4box);
    }
    if (!window.MP4Box) {
      throw new Error('mp4box.js failed to load');
    }
  }

  // Fetch a byte range, retrying transient failures
  async fetchRange(start, end) {
    let attempt = 0;

    for (;;) {
      try {
        return await this.request(start, end);
      } catch (error) {
        attempt += 1;
        // A TypeError is a network/CORS failure; Google's rate-limit page also shows up like this,
        // so only retry it once to avoid making the block worse
        const limit = error instanceof TypeError ? 1 : RETRIES;
        if (isAbort(error) || error.fatal || attempt > limit || this.destroyed) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  async request(start, end) {
    const controller = new AbortController();
    this.controller = controller;

    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: controller.signal,
    });

    if (response.status !== 206) {
      // Don't download the whole file just to find out ranges aren't supported
      controller.abort();
      const error = new Error(
        response.ok ? 'server does not support range requests' : `HTTP ${response.status} ${response.statusText}`,
      );
      // Client errors (bad key, not found, forbidden) won't fix themselves
      error.fatal = response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429);
      throw error;
    }

    const buffer = await response.arrayBuffer();
    const range = response.headers.get('Content-Range');
    const total = range ? Number(range.split('/')[1]) : NaN;

    this.stats.requests += 1;
    this.stats.bytes += buffer.byteLength;

    return { buffer, total: Number.isFinite(total) ? total : 0 };
  }

  // Content-Range may not be exposed to the page, so ask the Drive API for the size
  async fetchSize() {
    const { apiKey } = this.player.config.googleDrive;
    if (!this.id || is.empty(apiKey)) {
      return 0;
    }

    const url = format(
      this.player.config.urls.googleDrive.metadata,
      encodeURIComponent(this.id),
      encodeURIComponent(apiKey),
    );
    const response = await fetch(url);
    if (!response.ok) {
      return 0;
    }
    const { size } = await response.json();
    return Number(size) || 0;
  }

  attach() {
    return new Promise((resolve) => {
      const MediaSource = getMediaSource();
      this.mediaSource = new MediaSource();

      // ManagedMediaSource needs remote playback disabled (or an AirPlay alternative source)
      if (window.ManagedMediaSource && this.mediaSource instanceof window.ManagedMediaSource) {
        this.media.disableRemotePlayback = true;
      }

      this.mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
      this.objectUrl = URL.createObjectURL(this.mediaSource);
      this.media.src = this.objectUrl;

      this.media.addEventListener('seeking', this.onSeeking);
      this.media.addEventListener('timeupdate', this.onTimeUpdate);
    });
  }

  createFile() {
    this.file = window.MP4Box.createFile();
    this.file.onError = (error) => this.fail(new Error(`mp4box: ${error}`));
    this.file.onReady = (info) => this.onReady(info);
    this.file.onSegment = (id, track, buffer, sampleNumber, last) => {
      this.enqueue(track, buffer);
      this.file.releaseUsedSamples(id, sampleNumber);
      if (last) {
        track.ended = true;
      }
    };
  }

  // Called by mp4box once the moov box (the index) has been parsed
  onReady(info) {
    const MediaSource = getMediaSource();
    const selected = [info.videoTracks[0], info.audioTracks[0]].filter(Boolean);

    if (!selected.length) {
      throw Object.assign(new Error('no audio or video tracks'), { fallback: true });
    }

    selected.forEach((track) => {
      const mime = `${track.type}/mp4; codecs="${track.codec}"`;
      if (!MediaSource.isTypeSupported(mime)) {
        throw Object.assign(new Error(`codec not supported by this browser: ${mime}`), { fallback: true });
      }
    });

    if (info.duration && info.timescale) {
      this.mediaSource.duration = info.duration / info.timescale;
    }

    this.tracks = selected.map((track) => {
      const sourceBuffer = this.mediaSource.addSourceBuffer(`${track.type}/mp4; codecs="${track.codec}"`);
      const state = { id: track.id, type: track.type, sourceBuffer, queue: [], ended: false };

      sourceBuffer.addEventListener('updateend', () => {
        this.flushQueue(state);
        this.maybeEnd();
        this.pump();
      });

      const seconds = track.duration / track.timescale || 1;
      const nbSamples = Math.max(1, Math.round((track.nb_samples / seconds) * SEGMENT_DURATION));
      this.file.setSegmentOptions(track.id, state, { nbSamples });

      return state;
    });

    this.file.initializeSegmentation().forEach((segment) => {
      this.enqueue(segment.user, segment.buffer, true);
    });

    this.ready = true;
    this.justReady = true;
  }

  appendToFile(buffer, start) {
    const chunk = buffer;
    chunk.fileStart = start;
    const end = start + chunk.byteLength;
    const next = this.file.appendBuffer(chunk);

    if (!this.ready) {
      // Still looking for the moov box; mp4box tells us where the next box starts (it may skip over mdat)
      this.nextOffset = Math.max(next || 0, end);
    } else if (this.justReady) {
      // Index just parsed: start extracting from the playhead (for files with the moov at the end
      // this jumps back to the start of the media data)
      this.justReady = false;
      this.nextOffset = this.file.seek(this.media.currentTime || 0, true).offset;
      this.file.start();
    } else {
      // Skip over anything that's already been downloaded
      this.nextOffset = this.file.stream.getEndFilePositionAfter ? this.file.stream.getEndFilePositionAfter(end) : end;
    }
  }

  // Fetch the next chunk if more media is needed
  pump() {
    if (this.destroyed || this.fetching || !this.file) {
      return;
    }

    if (this.nextOffset >= this.size) {
      // Everything needed has been downloaded; emit the remaining samples
      if (this.ready && !this.flushed) {
        this.flushed = true;
        this.file.flush();
      }
      return;
    }

    if (this.ready) {
      // Wait for the SourceBuffers to catch up, and don't get too far ahead of the playhead
      const busy = this.tracks.some((track) => track.queue.length || track.sourceBuffer.updating);
      if (busy || this.bufferedAhead() >= this.bufferAhead) {
        return;
      }
    }

    const { generation } = this;
    const start = this.nextOffset;
    const end = Math.min(start + this.chunkSize, this.size) - 1;

    this.fetching = true;
    this.fetchRange(start, end)
      .then(({ buffer }) => {
        this.fetching = false;
        // A seek happened while this was downloading
        if (this.destroyed || generation !== this.generation) {
          return;
        }
        this.appendToFile(buffer, start);
        this.pump();
      })
      .catch((error) => {
        this.fetching = false;
        if (!isAbort(error)) {
          this.fail(error);
        }
      });
  }

  enqueue(track, buffer, init = false) {
    track.queue.push({ buffer, init });
    this.flushQueue(track);
  }

  flushQueue(track) {
    const { sourceBuffer, queue } = track;

    if (this.destroyed || sourceBuffer.updating || !queue.length || this.mediaSource.readyState === 'closed') {
      return;
    }

    // Free memory behind the playhead before adding more
    if (this.evict(track, this.bufferBehind)) {
      return;
    }

    try {
      sourceBuffer.appendBuffer(queue[0].buffer);
      queue.shift();
    } catch (error) {
      if (error.name === 'QuotaExceededError') {
        // Buffer full: drop more of what's behind and retry on updateend / timeupdate
        this.evict(track, 5);
      } else {
        this.fail(error);
      }
    }
  }

  // Remove buffered media more than `keep` seconds behind the playhead
  evict(track, keep) {
    const { sourceBuffer } = track;
    const { buffered } = sourceBuffer;
    const removeTo = this.media.currentTime - keep;

    if (!buffered.length || buffered.start(0) >= removeTo - 1) {
      return false;
    }

    sourceBuffer.remove(buffered.start(0), removeTo);
    return true;
  }

  bufferedAhead() {
    const { buffered, currentTime } = this.media;

    for (let i = 0; i < buffered.length; i += 1) {
      // Allow a small gap at the start of a range (e.g. the first frame's timestamp)
      if (buffered.start(i) <= currentTime + 0.5 && buffered.end(i) >= currentTime) {
        return buffered.end(i) - currentTime;
      }
    }

    return 0;
  }

  maybeEnd() {
    const done = this.tracks.every((track) => track.ended && !track.queue.length && !track.sourceBuffer.updating);

    if (done && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        // Ignore; it'll be retried on the next updateend
      }
    }
  }

  onSeeking() {
    if (!this.ready || this.destroyed) {
      return;
    }

    const time = this.media.currentTime;
    const { buffered } = this.media;

    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered.start(i) <= time && buffered.end(i) > time + 1) {
        // Already buffered, nothing to fetch
        return;
      }
    }

    // Cancel the in-flight request and jump to the byte offset for the new time
    this.generation += 1;
    if (this.controller) {
      this.controller.abort();
    }
    this.fetching = false;
    this.flushed = false;

    this.tracks.forEach((track) => {
      track.ended = false;
      // Drop segments queued for the old position (keep init segments)
      track.queue = track.queue.filter((entry) => entry.init);
    });

    this.nextOffset = this.file.seek(time, true).offset;
    this.pump();
  }

  onTimeUpdate() {
    this.tracks.forEach((track) => this.flushQueue(track));
    this.pump();
  }

  // Unrecoverable for chunked mode; play the file normally instead
  fail(error) {
    if (this.destroyed) {
      return;
    }

    if (error && error.fatal && !/range/.test(error.message)) {
      // Errors like a bad key or missing file would fail progressive playback too
      this.player.debug.error('Google Drive chunked streaming failed', error);
    }

    this.fallback(error && error.message);
  }

  fallback(reason) {
    if (this.destroyed) {
      return;
    }

    this.player.debug.warn(`Google Drive chunked streaming unavailable (${reason}), using progressive download`);
    this.stop();
    this.stats.mode = 'progressive';
    this.stats.reason = reason;

    this.media.src = this.url;
    this.media.load();
  }

  stop() {
    this.generation += 1;
    if (this.controller) {
      this.controller.abort();
    }
    this.media.removeEventListener('seeking', this.onSeeking);
    this.media.removeEventListener('timeupdate', this.onTimeUpdate);

    if (this.file) {
      this.file.stop();
      this.file.onSegment = null;
      this.file.onReady = null;
      this.file = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.tracks = [];
  }

  destroy() {
    this.stop();
    this.destroyed = true;
  }
}

export default GoogleDriveStream;
