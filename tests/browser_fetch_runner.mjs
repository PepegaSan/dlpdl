// Runs the extension's HLS browser fetch under Node (same fetch/Blob APIs).
// Usage: node browser_fetch_runner.mjs <module> <playlistUrl> <windowsJson> <outFile>
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [modulePath, playlistUrl, windowsJson, outFile] = process.argv.slice(2);
const { downloadHlsWindows } = await import(pathToFileURL(modulePath).href);
const result = await downloadHlsWindows(playlistUrl, JSON.parse(windowsJson));
await writeFile(outFile, Buffer.from(await result.blob.arrayBuffer()));
process.stdout.write(JSON.stringify({ timelineStart: result.timelineStart, parts: result.parts }));
