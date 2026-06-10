# 🎵 Vibestream — Offline Music Player

A modern, feature-rich offline music player built with vanilla JavaScript, CSS, and HTML. Upload your music, organize it into playlists, apply equalizer presets, and enjoy immersive visual experiences with reactive ambient mode and multiple visualizer modes.

---

## 🌟 Features

### 🎼 Music Management
- **Drag & Drop Upload**: Upload multiple audio files (MP3, WAV, OGG, M4A, FLAC, AAC)
- **Metadata Extraction**: Automatic title, artist, album, and cover art extraction via jsmediatags
- **Persistent Storage**: IndexedDB for offline library persistence
- **Smart Organization**: Songs organized by Artists, Albums, and custom Playlists
- **Search**: Real-time search across songs, artists, and albums
- **Voice Search**: Speech recognition support for hands-free searching

### 🎹 Playback Controls
- **5-Band Equalizer** with 7 presets: Flat, Rock, Pop, Jazz, Classical, Bass Boost, Vocal
- **Shuffle & Repeat**: Full shuffle with no-repeat cycles and repeat modes (all/one)
- **Playback History**: Spotify-style back/forward navigation
- **Queue Management**: View and manage upcoming songs
- **Keyboard Shortcuts**: Space (play/pause), Shift+Right (next), Shift+Left (previous)

### 🎨 Visual Enhancements
- **Ambient Mode**: Reactive, immersive visualization with:
  - Color-wash blobs (responsive to bass)
  - Dust particles (mid-frequency reactive)
  - Holi-style falling drops
  - Glitter sparkles (high-frequency reactive)
  - Beat detection shockwave rings
  - Dynamic palette extraction from album covers
- **Visualizer Modes** (fullscreen):
  - Bars: Frequency spectrum bars with mirror effect
  - Wave: Waveform with dual-layer rendering
  - Circle: Circular frequency representation
  - Grid: 16x10 frequency grid
- **Spatial Effects**: 
  - Normal (stereo)
  - 3D (gentle rotating stereo field)
  - 8D (wide circular head-motion panning)
  - Room/Hall/Cave (reverb simulations with impulse responses)

### 🎵 Playlist Features
- **Create Playlists**: Custom named playlists with descriptions
- **Liked Songs**: Heart-marked favorites collection
- **Add to Playlist**: Context menu options for quick addition
- **Playlist Detail View**: Dedicated view with play, shuffle, and upload options

### 🎭 UI/UX
- **Dark/Light Theme**: Toggle between dark and light modes
- **Responsive Design**: Works on desktop and touch devices
- **Real-time Stats**: Song, artist, and album count in sidebar
- **Toast Notifications**: User feedback for all operations
- **Context Menu**: Right-click options for song management
- **Material Icons**: Font Awesome icons throughout

### ⚙️ Technical Features
- **IndexedDB**: Local storage with transaction support
- **Web Audio API**: Advanced audio graph with EQ filters
- **Canvas Rendering**: High-performance 2D graphics for visualizations
- **Web Audio Convolver**: Synthetic impulse response reverb effects
- **Panner Node**: 3D spatial audio positioning
- **Requestable Permissions**: Audio context requires user interaction

---

## 📊 Technology Stack

| Technology | Composition | Purpose |
|-----------|-------------|---------|
| **JavaScript** | 51.7% | Core app logic, audio processing, DOM manipulation |
| **CSS** | 33.8% | Styling, animations, theme system |
| **HTML** | 14.5% | Semantic markup, accessibility |

### Key Libraries
- **jsmediatags** (CDN): Audio metadata extraction
- **Font Awesome 6.5.1** (CDN): Icon library

---

## 🚀 Getting Started

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/s0ura8hs/vibestreamsong.git
   cd vibestreamsong
   ```

2. Open `index.html` in a modern web browser (no build process needed)

### Usage
1. **Upload Music**: 
   - Click the upload button or drag files to the dropzone
   - Supported formats: MP3, WAV, OGG, M4A, FLAC, AAC

2. **Organize**:
   - Navigate to Library to view songs by type (Songs/Albums/Artists)
   - Create playlists and add songs via context menu
   - Use search or voice search to find tracks

3. **Play**:
   - Double-click or click songs to play
   - Use player controls (play/pause, next, previous)
   - Adjust volume with the slider

4. **Enhance**:
   - Open EQ panel to adjust 5-band equalizer or apply presets
   - Click Ambient for reactive visual effects
   - Click Visualizer for fullscreen mode with 4 visualization styles
   - Try spatial effects (3D, 8D, Room, Hall, Cave)

---

## 🎯 Project Structure

```
vibestreamsong/
├── index.html          # Main HTML (430 lines) - DOM shell with modals, panels
├── script.js           # Application logic (2015 lines)
│   ├── State management
│   ├── IndexedDB persistence
│   ├── Audio metadata extraction
│   ├── Upload & file handling pipeline
│   ├── Playback engine (with shuffle/repeat)
│   ├── Visualization rendering (ambient + visualizer)
│   ├── Web Audio API graph construction
│   ├── Equalizer with presets
│   ├── Voice search & commands
│   └── Event binding & initialization
├── style.css           # Styling (approx 49KB)
│   ├── Theme variables (dark/light)
│   ├── Component styles
│   ├── Animations & transitions
│   └── Responsive layouts
└── README.md           # Documentation
```

---

## 📝 Core Modules

### 1. **State Management** (`state` object)
```javascript
{
  songs: [],           // [{id, title, artist, album, duration, coverUrl, fileBlob}]
  playlists: [],       // [{id, name, desc, songIds, createdAt}]
  liked: Set(),        // favorite song IDs
  recent: [],          // recently played song IDs
  queue: [],           // current playback queue
  queueIndex: -1,      // position in queue
  currentId: null,     // now playing song
  shuffle: false,      // shuffle state
  repeat: 'off'        // off | all | one
}
```

### 2. **IndexedDB Schema**
- **songs**: Stores audio files, metadata, covers (blobs)
- **playlists**: Stores playlist definitions
- **meta**: Stores app state (liked, recent, shuffle, repeat)

### 3. **Web Audio Graph**
```
Source → [EQ Filters] → [Spatial Effects] → Analyser → Destination
                             ↓
              (Panner or Convolver based on effect)
```

### 4. **Upload Pipeline**
- Parallel file processing with progress tracking
- Metadata extraction via jsmediatags
- Duration measurement via Audio API
- Garbled text detection & cleanup
- Cover art extraction and blob storage

### 5. **Ambient Visualization**
- **Bass**: Controls blob size and speed
- **Mids**: Controls particle drift
- **Highs**: Controls sparkle frequency and dust size
- **Beat Detection**: Triggers shockwave rings

### 6. **Playback Modes**
- **Normal**: Sequential or shuffled playback
- **Shuffle**: Fisher-Yates shuffle with no-repeat cycles
- **Repeat All**: Loops the queue
- **Repeat One**: Repeats current song

---

## 🎛️ API Reference

### Core Functions

#### Playback
- `playSong(id, list)` - Start playing a song from a list
- `togglePlay()` - Play/pause toggle
- `next()` - Skip to next song
- `prev()` - Go to previous song
- `stop()` - Stop playback

#### File Management
- `handleFiles(fileList)` - Upload audio files (parallel processing)
- `deleteSong(id)` - Remove song from library
- `readTags(file)` - Extract metadata from audio file

#### Playlists
- `createPlaylist(name, desc)` - Create new playlist
- `deletePlaylist(id)` - Remove playlist
- `addSongToPlaylist(pid, sid)` - Add song to playlist
- `removeFromPlaylist(pid, sid)` - Remove song from playlist

#### Audio Processing
- `setupAudioGraph()` - Initialize Web Audio API context
- `applySpatialEffect(name)` - Apply spatial effect (none/3d/8d/room/hall/cave)
- `applyPreset(name)` - Apply EQ preset
- `reconnectGraph(eqEnabled)` - Reconnect audio graph after EQ toggle

#### Rendering
- `renderAll()` - Render all views
- `renderHome()` - Render home/discovery view
- `renderLibrary()` - Render library with tabs
- `renderPlaylistDetail()` - Render playlist songs
- `renderGroupDetail()` - Render album/artist detail
- `renderSearchResults()` - Render search matches

#### Visualizations
- `openAmbient()` / `closeAmbient()` - Toggle ambient mode
- `openVisualizer()` / `closeVisualizer()` - Toggle visualizer fullscreen
- `startAmbientLoop()` - Start ambient animation loop
- `startVisualizerLoop()` - Start visualizer animation loop

#### Utilities
- `toast(msg)` - Show notification
- `fmtTime(seconds)` - Format time (mm:ss)
- `normStr(s)` - Normalize string for comparison
- `splitArtists(artistStr)` - Parse multi-artist tags

---

## 🎨 Customization

### EQ Presets
Edit `EQ_PRESETS` in script.js:
```javascript
const EQ_PRESETS = {
  flat:      [0,0,0,0,0],      // [60Hz, 230Hz, 910Hz, 4kHz, 14kHz]
  custom:    [2,1,0,-1,3],     // Your custom preset
};
```

### Ambient Palette
Default Holi colors:
```javascript
palette: [
  { r: 255, g: 93, b: 143 },   // Pink
  { r: 156, g: 107, b: 255 },  // Purple
  { r: 79, g: 209, b: 197 },   // Cyan
  { r: 255, g: 209, b: 102 },  // Yellow
]
```

### Spatial Effects
Customize room/hall/cave reverb parameters:
```javascript
const configs = {
  room: { dur: 0.6,  decay: 4.0, wet: 0.45 },
  hall: { dur: 2.8,  decay: 2.5, wet: 0.55 },
  cave: { dur: 4.5,  decay: 1.8, wet: 0.65 },
};
```

---

## 🔧 Browser Support

- **Chrome/Edge**: Full support (Web Audio API, IndexedDB, Speech Recognition)
- **Firefox**: Full support (Web Audio API, IndexedDB)
- **Safari**: Full support (Web Audio API, IndexedDB, limited Panner support)
- **Mobile**: Supported (touch events, responsive layout)

> Note: Audio context requires user interaction (click/tap) to start due to browser autoplay policies.

---

## 🤝 Contributing

Contributions welcome! Please feel free to submit pull requests for:
- Bug fixes
- New visualization modes
- Additional EQ presets
- UI/UX improvements
- Performance optimizations

---

## 📄 License

This project is open source and available under the MIT License.

---

## 📞 Support

For issues, questions, or feature requests, please open an issue on GitHub.

---

## 🎵 Enjoy Your Music!

Vibestream is designed to be your personal, offline music sanctuary. Upload your favorite tracks, apply your custom sound, and immerse yourself in reactive visuals while you enjoy your music.

**Happy listening! 🎧**
