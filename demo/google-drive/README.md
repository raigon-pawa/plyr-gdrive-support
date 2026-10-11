# Google Drive demo

A standalone page for testing Google Drive playback. It is not part of the library or the plyr.io site.

It loads Plyr straight from `src/js` as native ES modules, so no build, Node or pnpm is needed. Only Python 3.

## Run it

1. From the repository root, run `python demo/google-drive/serve.py` (optionally pass a port, default `8765`)
2. Open <http://localhost:8765/demo/google-drive/>
3. Paste a Drive link shared as "Anyone with the link" and press **Load**

Edits to `src/js` show up on reload. You can also prefill the form from the URL: `?src=<drive link>&key=<api key>&type=video&mime=video/mp4`

`serve.py` is needed (rather than `python -m http.server`) because the source uses extensionless imports like `./utils/is`. The server resolves them to `.js` files. Plyr's two npm dependencies (`loadjs`, `rangetouch`) and the stylesheet come from jsDelivr, so you need an internet connection.

## Chunked streaming

Tick **Chunked streaming** (or add `&chunked=1` to the URL) to try `googleDrive: { chunked: true }`. Instead of one long download, the player fetches the file in 2 MB byte ranges, repackages them in the browser with [mp4box.js](https://github.com/gpac/mp4box.js) and feeds them to Media Source Extensions. It stops downloading once about 30 seconds are buffered ahead and frees what's more than 30 seconds behind. Seeking jumps straight to the right byte offset.

The status line under the stream URL shows the mode, the number of requests and how much of the file has been downloaded.

It needs an API key, an MP4 file and a codec the browser supports through MSE (H.264/AAC everywhere; HEVC only in some browsers). Otherwise it falls back to normal progressive playback, and the status line says why.

## Notes

- Your link and API key are only kept in your browser's `localStorage`, never in the repository. Use **Clear saved values** to remove them.
- Without an API key the public download endpoint is used. Seeking may be unreliable and popular files can hit Google's download quota.
- With an API key the Drive API is used, which supports seeking. Restrict the key to your HTTP referrers (e.g. `http://localhost:8765/*`) in Google Cloud Console.
