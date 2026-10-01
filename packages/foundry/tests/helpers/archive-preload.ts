import { startFakeArchive } from './fake-archive';

// Every test's local Archive is an in-memory fake, never this machine's real one.
const archive = startFakeArchive();
process.env.ARCHIVE_URL = archive.url;
process.env.ARCHIVE_TOKEN = archive.token;
