(function() {
// ========== دوال مساعدة ==========
function parseTime(e) {
    let t = e.trim().replace(",", ".").split(":");
    return 3 === t.length ? 3600 * parseFloat(t[0]) + 60 * parseFloat(t[1]) + parseFloat(t[2])
         : 2 === t.length ? 60 * parseFloat(t[0]) + parseFloat(t[1])
         : parseFloat(t[0]);
}

function parseLRC(e) {
    let lines = e.split(/\r?\n/);
    let entries = [];
    let regex = /\[(\d{2}):(\d{2})(?:[\.:](\d{1,3}))?\]/g;
    for (let line of lines) {
        regex.lastIndex = 0;
        let match;
        let times = [];
        while (null !== (match = regex.exec(line))) {
            let minutes = parseInt(match[1], 10);
            let seconds = parseInt(match[2], 10);
            let fraction = match[3] ? parseInt(match[3], 10) : 0;
            let fractionDivisor = match[3] && match[3].length === 3 ? 1000 : 100;
            let timeInSeconds = 60 * minutes + seconds + fraction / fractionDivisor;
            times.push(timeInSeconds);
        }
        let text = line.replace(/\[(\d{2}):(\d{2})(?:[\.:](\d{1,3}))?\]/g, "").trim();
        if (times.length > 0 && text !== "") {
            for (let t of times) {
                entries.push({ time: t, text: text });
            }
        }
    }
    return entries.sort((a, b) => a.time - b.time);
}

function convertLRCtoSRTlike(lrcEntries, fallbackDuration = 300) {
    let cues = [];
    for (let i = 0; i < lrcEntries.length; i++) {
        let start = lrcEntries[i].time;
        let end = (i + 1 < lrcEntries.length) ? lrcEntries[i + 1].time : start + fallbackDuration;
        if (end - start > 15) end = start + 5;
        cues.push({ start: start, end: end, text: lrcEntries[i].text });
    }
    return cues;
}

function loadLyricsData(content, fileName, audioDuration) {
    let nameLower = fileName.toLowerCase();
    let fallbackDuration = (audioDuration && isFinite(audioDuration) && audioDuration > 0) ? audioDuration : 300;
    if (nameLower.endsWith(".lrc") || nameLower.endsWith(".txt")) {
        let lrcEntries = parseLRC(content);
        if (lrcEntries.length === 0) return false;
        let cues = convertLRCtoSRTlike(lrcEntries, fallbackDuration);
        return { cues: cues, words: parseSRTtoWords(cues), content: content, fileName: fileName };
    } else {
        let blocks = content.split(/\r?\n\r?\n/);
        let cues = [];
        for (let block of blocks) {
            let lines = block.split(/\r?\n/);
            if (lines.length < 2) continue;
            let timingLine = lines[1];
            if (!timingLine.includes("-->")) continue;
            let parts = timingLine.split("-->");
            if (parts.length !== 2) continue;
            let start = parseTime(parts[0]);
            let end = parseTime(parts[1]);
            let text = lines.slice(2).join(" ").replace(/<[^>]*>/g, "").trim();
            if (text && !isNaN(start) && !isNaN(end)) {
                cues.push({ start: start, end: end, text: text });
            }
        }
        if (cues.length === 0) return false;
        return { cues: cues, words: parseSRTtoWords(cues), content: content, fileName: fileName };
    }
}

function parseSRTtoWords(cues) {
    let words = [];
    for (let cue of cues) {
        let tokens = cue.text.split(/\s+/);
        if (tokens.length === 0) continue;
        let durationPerWord = (cue.end - cue.start) / tokens.length;
        for (let i = 0; i < tokens.length; i++) {
            let word = tokens[i].replace(/[،,.;؟!]/g, "");
            if (word.length > 0) {
                words.push({ time: cue.start + i * durationPerWord, word: word });
            }
        }
    }
    return words.sort((a, b) => a.time - b.time);
}

function formatTime(e) {
    if (isNaN(e)) return "0:00";
    let minutes = Math.floor(e / 60);
    let seconds = Math.floor(e % 60);
    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
}

function showToast(msg) {
    let existing = document.querySelector(".toast");
    if (existing) existing.remove();
    let toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

// ========== المتغيرات العامة ==========
const audio = new Audio();
let songs = [], currentIndex = 0, isPlaying = false, isRepeating = false, isShuffling = false;
let isCameraRotating = false, rotationAngle = 0, cameraId = null;
let audioContext = null, source = null, gainNode = null, analyser = null, filters = [];
let isAudioInitialized = false, volumeEnhance = 0.7, boostLevel = 1, bassLevelVal = 0;
let wetGain = null, dryGain = null, mixGain = null, convolverNode = null, reverbSliderValue = 0.3;
let palaceEnabled = false, visualizerBars = [], visualizerAnimId = null, spectrumAnimId = null;
let waveDrawAnimationId = null, waveformLoopActive = false, autoResumeEnabled = true;
let userPaused = false, resumeTimeout = null, resumeAttempts = 0;
const MAX_RESUME_ATTEMPTS = 3, RESUME_INTERVAL = 10000;
const songLyricsMap = new Map();
let allObjectURLs = [], srtCues = [], wordTimeline = [], rawLyricsContent = null, rawLyricsFileName = null;
let currentMode = "word", lastStageIndex = -1, stageTransitionTimeout = null;

// ========== Graphic EQ System ==========
const GRAPHIC_EQ_BANDS = 18;
const EQ_MIN_DB = -12, EQ_MAX_DB = 12;
const eqFreqs = [80, 32, 50, 80, 125, 200, 315, 500, 800, 1200, 2000, 3150, 5000, 8000, 12500, 16000, 18000, 20000];
const eqLabels = ['80','32','50','80','125','200','315','500','800','1.2k','2k','3.15k','5k','8k','12.5k','16k','18k','20k'];
let eqValues = new Array(GRAPHIC_EQ_BANDS).fill(0);
let eqCanvas, eqCtx, eqPoints = [], activeEqIndex = -1;
let eqTooltip = document.getElementById('eqTooltip');
let resetEqBtn = document.getElementById('resetEqBtn');
const eqPresets = {
    flat:    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    bass:    [6,5,4,3,2,1,0,-1,-1,0,1,1,0,0,0,0,0,0],
    vocal:   [-2,-1,0,1,2,3,3,2,1,0,0,-1,-2,-2,-2,-1,-1,0],
    rock:    [4,4,3,2,1,0,1,2,3,3,3,2,1,0,0,0,0,0],
    electronic: [5,5,3,1,0,-1,0,1,2,3,3,2,1,1,0,0,0,0]
};

// ========== Media Session ==========
function updateMediaSession() {
    if ("mediaSession" in navigator) {
        let song = songs[currentIndex];
        if (song) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: song.title || "أغنية غير معروفة",
                artist: song.artist || "فنان فضي",
                album: "المشغل الفضي",
                artwork: [{ src: song.cover || "", sizes: "200x200", type: "image/png" }]
            });
        } else {
            navigator.mediaSession.metadata = null;
        }
    }
}

// ========== عناصر DOM ==========
const playPauseBtn = document.getElementById("playPauseBtn"),
      prevBtn = document.getElementById("prevBtn"),
      nextBtn = document.getElementById("nextBtn"),
      repeatBtn = document.getElementById("repeatBtn"),
      shuffleBtn = document.getElementById("shuffleBtn"),
      currentTimeSpan = document.getElementById("currentTime"),
      durationSpan = document.getElementById("duration"),
      volumeSlider = document.getElementById("volumeSlider"),
      volumeProgress = document.getElementById("volumeProgress"),
      fileInput = document.getElementById("fileInput"),
      playlistDiv = document.getElementById("playlist"),
      songTitleSpan = document.getElementById("songTitle"),
      songArtistSpan = document.getElementById("songArtist"),
      albumImage = document.getElementById("albumImage"),
      albumContainer = document.getElementById("albumArtContainer"),
      loadingOverlay = document.getElementById("loadingOverlay"),
      lyricsWordDiv = document.getElementById("lyricsWord"),
      stageContainer = document.getElementById("stageContainer"),
      prevWordDiv = document.getElementById("prevWord"),
      currentWordDiv = document.getElementById("currentWord"),
      nextWordDiv = document.getElementById("nextWord"),
      srtInput = document.getElementById("srtInput"),
      clearSrtBtn = document.getElementById("clearSrtBtn"),
      toggleModeBtn = document.getElementById("toggleModeBtn"),
      srtStatusMsg = document.getElementById("srtStatusMsg"),
      waveformCanvas = document.getElementById("waveformCanvas"),
      waveformContainer = document.getElementById("waveformContainer"),
      waveformClickTarget = document.getElementById("waveformClickTarget"),
      visualizerDiv = document.getElementById("visualizer"),
      spectrumCanvas = document.getElementById("spectrumCanvas"),
      spectrumCtx = spectrumCanvas.getContext("2d"),
      advancedSection = document.getElementById("advancedSection"),
      advancedToggleChip = document.getElementById("advancedToggleChip"),
      palaceControls = document.getElementById("palaceEffectControls"),
      playerSection = document.getElementById("playerSection"),
      dropOverlay = document.getElementById("dropOverlay"),
      burgerMenuBtn = document.getElementById("burgerMenuBtn"),
      burgerDropdown = document.getElementById("burgerDropdown"),
      playlistCountSpan = document.getElementById("playlistCount");

let waveformCtx = waveformCanvas.getContext("2d"), waveformData = null, advancedPanelVisible = true;

// ========== رسم الموجة الصوتية ==========
function resizeWaveformCanvas() {
    let rect = waveformContainer.getBoundingClientRect();
    waveformCanvas.width = rect.width * (window.devicePixelRatio || 1);
    waveformCanvas.height = rect.height * (window.devicePixelRatio || 1);
    waveformCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    if (waveformData) drawWaveform();
}
window.addEventListener("resize", () => { resizeWaveformCanvas(); if (waveformData) drawWaveform(); });
setTimeout(resizeWaveformCanvas, 100);

function extractWaveformData(buffer) {
    let data = buffer.getChannelData(0);
    let width = waveformCanvas.width;
    let step = Math.floor(data.length / width);
    let peaks = [];
    for (let i = 0; i < width; i++) {
        let start = step * i, end = Math.min(start + step, data.length);
        let max = 0;
        for (let j = start; j < end; j++) { let val = Math.abs(data[j]); if (val > max) max = val; }
        peaks.push(max);
    }
    let globalMax = Math.max(...peaks, 0.001);
    return peaks.map(p => p / globalMax);
}

async function loadAudioBuffer(url) {
    try {
        let response = await fetch(url);
        let arrayBuffer = await response.arrayBuffer();
        let ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
        if (!audioContext) audioContext = ctx;
        let audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        waveformData = extractWaveformData(audioBuffer);
        drawWaveform();
    } catch (err) { console.warn("تعذر تحميل الموجة:", err); waveformData = null; }
}

function drawWaveform(currentTime = audio.currentTime || 0, duration = audio.duration || 1) {
    if (!waveformData || !waveformCtx) return;
    let w = waveformCanvas.width / (window.devicePixelRatio || 1);
    let h = waveformCanvas.height / (window.devicePixelRatio || 1);
    waveformCtx.clearRect(0, 0, w, h);
    waveformCtx.fillStyle = "#0A0A0D"; waveformCtx.fillRect(0, 0, w, h);
    let barWidth = w / waveformData.length, centerY = h / 2, progressX = (currentTime / duration) * w;
    for (let i = 0; i < waveformData.length; i++) {
        let x = i * barWidth, peak = waveformData[i], barHeight = peak * (0.8 * h);
        waveformCtx.fillStyle = x < progressX ? "rgba(210,210,240,1)" : "rgba(180,180,210,0.7)";
        waveformCtx.fillRect(x, centerY - barHeight / 2, barWidth - 1, barHeight);
    }
    waveformCtx.beginPath(); waveformCtx.strokeStyle = "#FFFFFF"; waveformCtx.lineWidth = 2;
    waveformCtx.moveTo(progressX, 0); waveformCtx.lineTo(progressX, h); waveformCtx.stroke();
}

function startWaveformProgress() {
    if (!waveformLoopActive) {
        waveformLoopActive = true;
        function loop() {
            if (!waveformLoopActive) return;
            if (!audio.paused && waveformData && audio.duration) drawWaveform(audio.currentTime, audio.duration);
            waveDrawAnimationId = requestAnimationFrame(loop);
        }
        loop();
    }
}
function stopWaveformProgress() { waveformLoopActive = false; if (waveDrawAnimationId) { cancelAnimationFrame(waveDrawAnimationId); waveDrawAnimationId = null; } }

// ========== الاستئناف التلقائي ==========
function startAutoResume() { if (autoResumeEnabled && isPlaying && songs.length) { stopAutoResume(); resumeAttempts = 0; attemptResume(); } }
function attemptResume() {
    if (resumeAttempts >= MAX_RESUME_ATTEMPTS) { stopAutoResume(); return; }
    resumeAttempts++;
    resumeTimeout = setTimeout(async () => {
        if (!userPaused && autoResumeEnabled && songs.length && audio.paused) {
            await audio.play().then(() => {
                isPlaying = true; playPauseBtn.innerHTML = "⏸️"; startAlbumRotation(); enableSlow3D(true);
                startVisualizerLoop(); startSpectrumLoop(); startWaveformProgress(); updateMediaSession();
                stopAutoResume(); showToast("🔄 تم استئناف الموسيقى تلقائياً");
            }).catch(() => attemptResume());
        } else stopAutoResume();
    }, RESUME_INTERVAL);
}
function stopAutoResume() { if (resumeTimeout) { clearTimeout(resumeTimeout); resumeTimeout = null; } resumeAttempts = 0; }

// ========== السحب على الموجة ==========
function handleWaveformSeek(clientX) {
    if (audio.duration && waveformData) {
        let rect = waveformContainer.getBoundingClientRect();
        let ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        audio.currentTime = ratio * audio.duration;
        updateLyricsByTime(audio.currentTime);
    }
}
waveformClickTarget.addEventListener("click", e => handleWaveformSeek(e.clientX));
waveformClickTarget.addEventListener("mousedown", e => {
    if (!audio.duration || !waveformData) return;
    let rect = waveformContainer.getBoundingClientRect();
    let onMove = (ev) => { let ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)); audio.currentTime = ratio * audio.duration; updateLyricsByTime(audio.currentTime); };
    let onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    handleWaveformSeek(e.clientX);
});
waveformClickTarget.addEventListener("touchstart", e => {
    if (!audio.duration || !waveformData) return;
    let rect = waveformContainer.getBoundingClientRect();
    let onMove = (ev) => { let ratio = Math.min(1, Math.max(0, (ev.touches[0].clientX - rect.left) / rect.width)); audio.currentTime = ratio * audio.duration; updateLyricsByTime(audio.currentTime); };
    let onEnd = () => { document.removeEventListener("touchmove", onMove); document.removeEventListener("touchend", onEnd); };
    document.addEventListener("touchmove", onMove, { passive: true }); document.addEventListener("touchend", onEnd);
    handleWaveformSeek(e.touches[0].clientX);
});

// ========== إيماءات اللمس ==========
let touchStartX = 0, touchStartY = 0, touchHandled = false;
const musicPlayerContainer = document.getElementById("musicPlayerContainer");
musicPlayerContainer.addEventListener("touchstart", e => {
    if (e.target.closest(".playlist-item, button, input, label, .waveform-click-target, .volume-slider")) touchHandled = false;
    else { touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; touchHandled = false; }
}, { passive: true });
musicPlayerContainer.addEventListener("touchmove", e => {
    if (!touchHandled && Math.abs(e.touches[0].clientY - touchStartY) < 30) {
        let diffX = e.touches[0].clientX - touchStartX;
        if (Math.abs(diffX) > 60) {
            touchHandled = true;
            if (diffX < -40) { playNext(); if (isPlaying) audio.play(); showToast("⏭️ الأغنية التالية"); }
            else if (diffX > 40 && songs.length) { currentIndex--; if (currentIndex < 0) currentIndex = songs.length - 1; loadSong(currentIndex); if (isPlaying) audio.play(); updatePlaylistActive(); showToast("⏮️ الأغنية السابقة"); }
        }
    }
}, { passive: true });
musicPlayerContainer.addEventListener("touchend", () => { touchHandled = false; });

// ========== نظام الكلمات ==========
function updateLyricsByTime(currentTime) {
    if (currentMode === "word") {
        if (!wordTimeline.length) { if (lyricsWordDiv.innerText !== "🎤 ارفع SRT/LRC") lyricsWordDiv.innerText = "🎤 ارفع SRT/LRC"; return; }
        let foundWord = null;
        for (let i = 0; i < wordTimeline.length && wordTimeline[i].time <= currentTime; i++) foundWord = wordTimeline[i].word;
        if (foundWord && lyricsWordDiv.innerText !== foundWord) lyricsWordDiv.innerText = foundWord;
        else if (!foundWord && lyricsWordDiv.innerText !== "✨ استعد") lyricsWordDiv.innerText = "✨ استعد";
    } else if (currentMode === "sentence") {
        if (!srtCues.length) { if (lyricsWordDiv.innerText !== "🎤 ارفع SRT/LRC") lyricsWordDiv.innerText = "🎤 ارفع SRT/LRC"; return; }
        let foundCue = null;
        for (let cue of srtCues) { if (currentTime >= cue.start && currentTime <= cue.end) { foundCue = cue; break; } }
        if (foundCue) {
            let displayText = foundCue.text.length > 85 ? foundCue.text.substring(0, 85) + "..." : foundCue.text;
            if (lyricsWordDiv.innerText !== displayText) lyricsWordDiv.innerText = displayText;
        } else if (lyricsWordDiv.innerText !== "✨ يترقب") lyricsWordDiv.innerText = "✨ يترقب";
    } else if (currentMode === "stage") {
        if (!wordTimeline.length) { prevWordDiv.textContent = ""; currentWordDiv.textContent = "🎤 ارفع SRT/LRC"; nextWordDiv.textContent = ""; return; }
        let activeIndex = -1;
        for (let i = 0; i < wordTimeline.length && wordTimeline[i].time <= currentTime; i++) activeIndex = i;
        if (activeIndex !== lastStageIndex) { updateStageWords(activeIndex); lastStageIndex = activeIndex; }
    }
}
function updateStageWords(index) { /* كما هي في النسخة السابقة، لم تتغير */ }

audio.addEventListener("timeupdate", () => {
    if (audio.duration) { currentTimeSpan.textContent = formatTime(audio.currentTime); durationSpan.textContent = formatTime(audio.duration); }
    updateLyricsByTime(audio.currentTime);
});
function enableSlow3D(enable) { if (enable) lyricsWordDiv.classList.add("rotate-3d-active"); else lyricsWordDiv.classList.remove("rotate-3d-active"); }
function switchUIMode() { /* لم تتغير */ }
function toggleMode() { /* لم تتغير */ }
function clearSRT() { /* لم تتغير */ }
function processLyricsFile(content, fileName) { /* لم تتغير */ }
srtInput.addEventListener("change", e => { /* لم تتغير */ });
clearSrtBtn.addEventListener("click", clearSRT);
toggleModeBtn.addEventListener("click", toggleMode);
function getCurrentSongId() { return songs[currentIndex]?.src || null; }
function loadLyricsForCurrentSong() { /* لم تتغير */ }

// ========== قائمة التشغيل ==========
function getAudioDuration(file) { /* لم تتغير */ }
function updatePlaylistCount() { playlistCountSpan.textContent = songs.length; }
function renderPlaylistItem(index) { /* لم تتغير */ }
function refreshPlaylist() { /* لم تتغير */ }
function updatePlaylistActive() { /* لم تتغير */ }
function deleteSong(index) { /* لم تتغير */ }
function moveSong(from, to) { /* لم تتغير */ }
function clearAllPlaylist() { /* لم تتغير */ }
function exportPlaylist() { /* لم تتغير */ }
function importPlaylist(file) { /* لم تتغير */ }
async function addSongs(files) { /* لم تتغير */ }

function stopAlbumRotation() { albumContainer.classList.remove("rotating"); }
function startAlbumRotation() { if (isPlaying) albumContainer.classList.add("rotating"); }
function showLoading() { loadingOverlay.style.display = "flex"; }
function hideLoading() { loadingOverlay.style.display = "none"; }

async function loadSong(index) {
    if (!songs[index]) return;
    showLoading();
    audio.src = songs[index].src;
    songTitleSpan.textContent = songs[index].title;
    songArtistSpan.textContent = songs[index].artist || "فنان فضي";
    albumImage.src = songs[index].cover || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%232A2A38'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='20' fill='%23E8E8F2'%3Eغلاف%3C/text%3E%3C/svg%3E";
    waveformData = null;
    if (songs[index].src) loadAudioBuffer(songs[index].src);
    loadLyricsForCurrentSong();
    updateMediaSession();
    audio.oncanplay = () => hideLoading();
    audio.onerror = () => { hideLoading(); srtStatusMsg.innerHTML = "⚠️ خطأ في تحميل الملف الصوتي"; };
    if (isPlaying) { audio.play().catch(() => {}); enableSlow3D(true); } else enableSlow3D(false);
    updateLyricsByTime(0);
    setTimeout(() => { if (waveformData) drawWaveform(0, audio.duration || 1); }, 300);
    updatePlaylistActive();
    if (songs[index].duration <= 0 && audio.duration && !isNaN(audio.duration)) { songs[index].duration = audio.duration; refreshPlaylist(); updatePlaylistActive(); }
}

function playNext() {
    if (!songs.length) return;
    if (isShuffling) { let next; do { next = Math.floor(Math.random() * songs.length); } while (next === currentIndex && songs.length > 1); currentIndex = next; }
    else { currentIndex++; if (currentIndex >= songs.length) currentIndex = 0; }
    loadSong(currentIndex);
    if (isPlaying) audio.play();
    updatePlaylistActive();
}

// ========== دوال الصوت والمعادل ==========
function applyBoostSettings() {
    if (gainNode) {
        gainNode.gain.value = volumeEnhance * boostLevel;
        if (filters.length > 0 && filters[0].type === "lowshelf") { filters[0].gain.value = bassLevelVal; }
        // تطبيق قيم المعادل
        if (filters.length === GRAPHIC_EQ_BANDS) {
            eqValues.forEach((val, i) => { if (filters[i]) filters[i].gain.value = val; });
        }
        saveSettings();
    }
}

function createReverbBuffer(ctx, duration = 2.8, decay = 3.5) { /* كما هي */ }

async function initAudioContext() {
    if (isAudioInitialized) return;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
        if (audioContext.state === "suspended") await audioContext.resume();
        source = audioContext.createMediaElementSource(audio);
        gainNode = audioContext.createGain();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.7;

        let freqs = [80, 32, 50, 80, 125, 200, 315, 500, 800, 1200, 2000, 3150, 5000, 8000, 12500, 16000, 18000, 20000];
        filters = freqs.map((freq, i) => {
            let filter = audioContext.createBiquadFilter();
            if (i === 0) filter.type = "lowshelf";
            else if (i === freqs.length - 1) filter.type = "highshelf";
            else filter.type = "peaking";
            filter.frequency.value = freq;
            filter.Q.value = 0.7;
            filter.gain.value = 0;
            return filter;
        });

        source.connect(gainNode);
        let currentNode = gainNode;
        filters.forEach(f => { currentNode.connect(f); currentNode = f; });

        convolverNode = audioContext.createConvolver();
        convolverNode.buffer = createReverbBuffer(audioContext, 2.8, 3.5);
        wetGain = audioContext.createGain(); dryGain = audioContext.createGain(); mixGain = audioContext.createGain();
        wetGain.gain.value = 1.2 * reverbSliderValue; dryGain.gain.value = 0.8;
        currentNode.connect(dryGain); dryGain.connect(mixGain);
        currentNode.connect(convolverNode); convolverNode.connect(wetGain); wetGain.connect(mixGain);
        mixGain.connect(analyser); analyser.connect(audioContext.destination);

        isAudioInitialized = true;
        applyBoostSettings();
        loadSettings();
        startSpectrumLoop();
        startVisualizerLoop();
    } catch (e) { console.error("فشل تهيئة الصوت:", e); }
}

function startSpectrumLoop() { /* لم تتغير */ }
function stopSpectrumLoop() { /* لم تتغير */ }
function startVisualizerLoop() { /* لم تتغير */ }
function stopVisualizerLoop() { /* لم تتغير */ }

// ========== أزرار التحكم الأساسية ==========
playPauseBtn.onclick = async () => {
    if (!songs.length) { alert("أضف أغاني أولا"); return; }
    if (!isAudioInitialized) await initAudioContext();
    if (isPlaying) {
        userPaused = true; stopAutoResume(); audio.pause(); playPauseBtn.innerHTML = "▶️";
        stopAlbumRotation(); enableSlow3D(false); stopVisualizerLoop(); stopSpectrumLoop(); stopWaveformProgress();
    } else {
        userPaused = false;
        if (audioContext && audioContext.state === "suspended") await audioContext.resume();
        audio.play(); playPauseBtn.innerHTML = "⏸️"; startAlbumRotation(); enableSlow3D(true);
        startVisualizerLoop(); startSpectrumLoop(); startWaveformProgress();
    }
    isPlaying = !isPlaying;
    updateMediaSession();
};
audio.addEventListener("ended", () => { if (isRepeating) { audio.currentTime = 0; audio.play(); } else playNext(); });
audio.addEventListener("pause", () => { if (!userPaused && autoResumeEnabled && isPlaying && songs.length) startAutoResume(); });
audio.addEventListener("play", () => { userPaused = false; stopAutoResume(); });

volumeSlider.addEventListener("click", e => {
    let ratio = Math.min(1, Math.max(0, e.offsetX / volumeSlider.clientWidth));
    audio.volume = ratio; volumeProgress.style.width = (100 * ratio) + "%"; volumeEnhance = ratio; applyBoostSettings();
});
repeatBtn.onclick = () => { isRepeating = !isRepeating; repeatBtn.classList.toggle("active", isRepeating); };
shuffleBtn.onclick = () => { isShuffling = !isShuffling; shuffleBtn.classList.toggle("active", isShuffling); };
nextBtn.onclick = () => { playNext(); if (isPlaying) audio.play(); };
prevBtn.onclick = () => {
    if (!songs.length) return;
    currentIndex--; if (currentIndex < 0) currentIndex = songs.length - 1;
    loadSong(currentIndex); if (isPlaying) audio.play(); updatePlaylistActive();
};

// ========== رقاقات الشريط العلوي ==========
let boostActive = false;
const boostChip = document.getElementById("boostChip");
boostChip.onclick = () => {
    if (boostActive) { boostLevel = 1; boostActive = false; boostChip.classList.remove("active-chip"); }
    else { boostLevel = 1.8; boostActive = true; boostChip.classList.add("active-chip"); }
    applyBoostSettings();
    document.getElementById("boostEnhancementSlider").value = 50 * (boostLevel - 1);
    document.getElementById("boostIndicator").innerText = "x" + boostLevel.toFixed(1);
};

let powerSave = false;
const powerSaveChip = document.getElementById("powerSaveChip");
powerSaveChip.onclick = () => {
    powerSave = !powerSave;
    document.body.classList.toggle("power-save-mode", powerSave);
    powerSaveChip.classList.toggle("active-chip", powerSave);
    if (powerSave && isCameraRotating) cameraToggleChip.click();
    if (powerSave) { stopAlbumRotation(); stopVisualizerLoop(); stopSpectrumLoop(); }
    else if (isPlaying) { startVisualizerLoop(); startSpectrumLoop(); }
};

const cameraToggleChip = document.getElementById("cameraToggleChip");
cameraToggleChip.onclick = () => {
    if (powerSave) { showToast("وضع توفير الطاقة مفعّل"); return; }
    isCameraRotating = !isCameraRotating;
    if (isCameraRotating) {
        cameraToggleChip.classList.add("active-chip"); cameraToggleChip.textContent = "⏹️";
        function rotate() { if (!isCameraRotating) return; rotationAngle += 0.6; playerSection.style.transform = "rotateY(" + rotationAngle + "deg) rotateX(4deg)"; cameraId = requestAnimationFrame(rotate); }
        rotate();
    } else { cancelAnimationFrame(cameraId); playerSection.style.transform = "none"; cameraToggleChip.classList.remove("active-chip"); cameraToggleChip.textContent = "🎥"; }
};

const palaceToggleChip = document.getElementById("palaceToggleChip");
palaceToggleChip.onclick = () => { palaceEnabled = !palaceEnabled; palaceControls.style.display = palaceEnabled ? "block" : "none"; palaceToggleChip.classList.toggle("palace-active", palaceEnabled); };

advancedToggleChip.onclick = () => {
    advancedPanelVisible = !advancedPanelVisible;
    if (advancedPanelVisible) { advancedSection.classList.remove("hidden-panel"); advancedToggleChip.classList.add("active-chip"); }
    else { advancedSection.classList.add("hidden-panel"); advancedToggleChip.classList.remove("active-chip"); }
};

// ========== المودالات ==========
const infoChip = document.getElementById("infoChip"), infoModal = document.getElementById("infoModal"), closeInfoModalBtn = document.getElementById("closeInfoModal");
infoChip.onclick = () => infoModal.classList.add("open");
closeInfoModalBtn.onclick = () => infoModal.classList.remove("open");
infoModal.addEventListener("click", e => { if (e.target === infoModal) infoModal.classList.remove("open"); });
const shortcutsFab = document.getElementById("shortcutsFab"), shortcutsModal = document.getElementById("shortcutsModal"), closeShortcutsModalBtn = document.getElementById("closeShortcutsModal");
shortcutsFab.onclick = () => shortcutsModal.classList.add("open");
closeShortcutsModalBtn.onclick = () => shortcutsModal.classList.remove("open");
shortcutsModal.addEventListener("click", e => { if (e.target === shortcutsModal) shortcutsModal.classList.remove("open"); });
document.getElementById("fullscreenFab").onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); };

burgerMenuBtn.addEventListener("click", e => { e.stopPropagation(); burgerDropdown.classList.toggle("open"); burgerMenuBtn.classList.toggle("active"); });
document.addEventListener("click", e => { if (!burgerDropdown.contains(e.target) && e.target !== burgerMenuBtn) { burgerDropdown.classList.remove("open"); burgerMenuBtn.classList.remove("active"); } });
burgerDropdown.querySelectorAll(".dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
        let action = item.dataset.action;
        burgerDropdown.classList.remove("open"); burgerMenuBtn.classList.remove("active");
        if (action === "camera") cameraToggleChip.click(); else if (action === "palace") palaceToggleChip.click();
        else if (action === "boost") boostChip.click(); else if (action === "powersave") powerSaveChip.click();
        else if (action === "advanced") advancedToggleChip.click(); else if (action === "info") infoChip.click();
        else if (action === "shortcuts") shortcutsFab.click();
    });
});

document.getElementById("exportPlaylistBtn").addEventListener("click", exportPlaylist);
document.getElementById("importPlaylistBtn").addEventListener("click", () => { document.getElementById("importPlaylistInput").click(); });
document.getElementById("importPlaylistInput").addEventListener("change", e => { if (e.target.files[0]) { importPlaylist(e.target.files[0]); e.target.value = ""; } });
document.getElementById("clearPlaylistBtn").addEventListener("click", clearAllPlaylist);
fileInput.addEventListener("change", e => { addSongs(Array.from(e.target.files)); fileInput.value = ""; });
document.getElementById("imageInput").addEventListener("change", e => {
    if (e.target.files[0]) {
        let reader = new FileReader();
        reader.onload = ev => { albumImage.src = ev.target.result; if (songs[currentIndex]) songs[currentIndex].cover = ev.target.result; updateMediaSession(); };
        reader.readAsDataURL(e.target.files[0]);
    }
});

// تأثيرات القصر
document.getElementById("applyPalaceEffect").addEventListener("click", () => {
    let size = parseFloat(document.getElementById("palaceSize").value) / 100;
    if (wetGain && dryGain) {
        wetGain.gain.value = Math.min(1.3, reverbSliderValue + 0.9 * size);
        dryGain.gain.value = Math.max(0.4, 0.8 - 0.25 * size);
        document.getElementById("palaceStatus").innerHTML = "🏰 قصر نشط: صدى " + Math.round(100 * wetGain.gain.value) + "%";
    }
});
document.getElementById("resetPalaceEffect").addEventListener("click", () => {
    if (wetGain && dryGain) { wetGain.gain.value = 1.2 * reverbSliderValue; dryGain.gain.value = 0.8; document.getElementById("palaceStatus").innerHTML = "تم إعادة التعيين"; }
});
document.getElementById("palaceSize").addEventListener("input", e => { document.getElementById("palaceSizeValue").innerText = e.target.value + "%"; });

// ========== Graphic EQ Implementation ==========
function initGraphicEQ() {
    eqCanvas = document.getElementById('graphicEqCanvas');
    eqCtx = eqCanvas.getContext('2d');

    function resizeCanvas() {
        const wrapper = eqCanvas.parentElement;
        const rect = wrapper.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        eqCanvas.width = rect.width * dpr;
        eqCanvas.height = 200 * dpr;
        eqCanvas.style.width = rect.width + 'px';
        eqCanvas.style.height = '200px';
        eqCtx.setTransform(1, 0, 0, 1, 0, 0);
        eqCtx.scale(dpr, dpr);
        updateEqPoints();
        drawEqCanvas();
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    eqCanvas.addEventListener('mousedown', onEqMouseDown);
    window.addEventListener('mousemove', onEqMouseMove);
    window.addEventListener('mouseup', onEqMouseUp);
    eqCanvas.addEventListener('touchstart', onEqTouchStart, { passive: false });
    eqCanvas.addEventListener('touchmove', onEqTouchMove, { passive: false });
    eqCanvas.addEventListener('touchend', onEqTouchEnd);
    eqCanvas.addEventListener('touchcancel', onEqTouchEnd);

    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const preset = btn.dataset.preset;
            if (eqPresets[preset]) {
                setEqValues(eqPresets[preset]);
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                saveSettings();
            }
        });
    });

    resetEqBtn.addEventListener('click', () => {
        setEqValues(eqPresets.flat);
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.preset-btn[data-preset="flat"]').classList.add('active');
        saveSettings();
    });

    document.getElementById('eqGridLabels').innerHTML = eqLabels.map(f => `<span>${f}</span>`).join('');
}

function setEqValues(values) {
    if (!values || values.length !== GRAPHIC_EQ_BANDS) return;
    eqValues = [...values];
    if (filters && filters.length === GRAPHIC_EQ_BANDS) {
        filters.forEach((filter, i) => { filter.gain.value = eqValues[i]; });
    }
    updateEqPoints();
    drawEqCanvas();
}

function updateEqPoints() {
    if (!eqCanvas) return;
    const w = eqCanvas.width / (window.devicePixelRatio || 1);
    const h = 200;
    const padX = 30, padY = 25;
    const gW = w - padX * 2, gH = h - padY * 2;
    eqPoints = eqValues.map((db, i) => {
        const x = padX + (i / (GRAPHIC_EQ_BANDS - 1)) * gW;
        const norm = (db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB);
        const y = padY + gH - norm * gH;
        return { x, y, db };
    });
}

function drawEqCanvas() {
    if (!eqCtx) return;
    const w = eqCanvas.width / (window.devicePixelRatio || 1);
    const h = 200;
    const padX = 30, padY = 25;
    const gW = w - padX * 2, gH = h - padY * 2;

    eqCtx.clearRect(0, 0, w, h);
    eqCtx.fillStyle = '#09090D';
    eqCtx.fillRect(padX, padY, gW, gH);

    eqCtx.strokeStyle = 'rgba(200,200,220,0.08)';
    eqCtx.lineWidth = 1;
    eqCtx.font = '9px "Segoe UI"';
    eqCtx.fillStyle = '#888';
    for (let db = EQ_MIN_DB; db <= EQ_MAX_DB; db += 3) {
        const y = padY + gH - ((db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * gH;
        eqCtx.beginPath(); eqCtx.moveTo(padX, y); eqCtx.lineTo(w - padX, y); eqCtx.stroke();
        eqCtx.textAlign = 'left'; eqCtx.fillText(db + 'dB', 4, y + 3);
    }

    if (eqPoints.length < 2) return;
    eqCtx.beginPath();
    eqCtx.strokeStyle = '#E8E8F2';
    eqCtx.lineWidth = 2.8;
    eqCtx.shadowColor = 'rgba(232,232,242,0.7)';
    eqCtx.shadowBlur = 12;
    eqCtx.moveTo(eqPoints[0].x, eqPoints[0].y);
    for (let i = 0; i < eqPoints.length - 1; i++) {
        const p0 = eqPoints[i === 0 ? 0 : i - 1];
        const p1 = eqPoints[i];
        const p2 = eqPoints[i + 1];
        const p3 = eqPoints[i + 2 < eqPoints.length ? i + 2 : i + 1];
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        eqCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    eqCtx.stroke();
    eqCtx.shadowBlur = 0;

    eqPoints.forEach((pt, i) => {
        const r = (i === activeEqIndex) ? 9 : 7;
        eqCtx.beginPath();
        eqCtx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
        eqCtx.fillStyle = (i === activeEqIndex) ? '#FFFFFF' : '#D0D0F0';
        eqCtx.fill();
        eqCtx.strokeStyle = '#1A1A28'; eqCtx.lineWidth = 2; eqCtx.stroke();
    });
}

function yToDb(canvasY) {
    const h = 200, padY = 25, gH = h - padY * 2;
    let norm = 1 - (canvasY - padY) / gH;
    norm = Math.min(1, Math.max(0, norm));
    return Math.round((EQ_MIN_DB + norm * (EQ_MAX_DB - EQ_MIN_DB)) * 2) / 2;
}

function findClosestPoint(clientX, clientY) {
    const rect = eqCanvas.getBoundingClientRect();
    const scaleX = (eqCanvas.width / (window.devicePixelRatio || 1)) / rect.width;
    const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height;
    const mx = (clientX - rect.left) * scaleX;
    const my = (clientY - rect.top) * scaleY;
    let minDist = Infinity, idx = -1;
    eqPoints.forEach((p, i) => {
        const dx = p.x - mx, dy = p.y - my, dist = dx*dx + dy*dy;
        if (dist < minDist && dist < 400) { minDist = dist; idx = i; }
    });
    return idx;
}

function updateSingleBand(index, db) {
    db = Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, db));
    eqValues[index] = db;
    if (filters && filters[index]) filters[index].gain.value = db;
    updateEqPoints();
    drawEqCanvas();
}

function onEqMouseDown(e) {
    const idx = findClosestPoint(e.clientX, e.clientY);
    if (idx !== -1) { activeEqIndex = idx; showEqTooltip(e.clientX, e.clientY, eqValues[idx]); drawEqCanvas(); e.preventDefault(); }
}
function onEqMouseMove(e) {
    if (activeEqIndex === -1) return;
    const rect = eqCanvas.getBoundingClientRect();
    const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height;
    const canvasY = (e.clientY - rect.top) * scaleY;
    const newDb = yToDb(canvasY);
    updateSingleBand(activeEqIndex, newDb);
    showEqTooltip(e.clientX, e.clientY, newDb);
}
function onEqMouseUp() { if (activeEqIndex !== -1) { hideEqTooltip(); activeEqIndex = -1; drawEqCanvas(); saveSettings(); } }
function onEqTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const idx = findClosestPoint(touch.clientX, touch.clientY);
    if (idx !== -1) { activeEqIndex = idx; showEqTooltip(touch.clientX, touch.clientY, eqValues[idx]); drawEqCanvas(); }
}
function onEqTouchMove(e) {
    e.preventDefault();
    if (activeEqIndex === -1) return;
    const touch = e.touches[0];
    const rect = eqCanvas.getBoundingClientRect();
    const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height;
    const canvasY = (touch.clientY - rect.top) * scaleY;
    const newDb = yToDb(canvasY);
    updateSingleBand(activeEqIndex, newDb);
    showEqTooltip(touch.clientX, touch.clientY, newDb);
}
function onEqTouchEnd() { if (activeEqIndex !== -1) { hideEqTooltip(); activeEqIndex = -1; drawEqCanvas(); saveSettings(); } }

function showEqTooltip(clientX, clientY, db) {
    if (!eqTooltip) return;
    const rect = eqCanvas.getBoundingClientRect();
    eqTooltip.textContent = (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
    eqTooltip.style.left = (clientX - rect.left) + 'px';
    eqTooltip.style.top = (clientY - rect.top - 35) + 'px';
    eqTooltip.style.display = 'block';
}
function hideEqTooltip() { if (eqTooltip) eqTooltip.style.display = 'none'; }

// ========== حفظ واستعادة الإعدادات ==========
function saveSettings() {
    let settings = {
        volumeEnhance: volumeEnhance,
        boostLevel: boostLevel,
        bassLevelVal: bassLevelVal,
        reverbSliderValue: reverbSliderValue,
        eqValues: eqValues,
        volume: audio.volume
    };
    localStorage.setItem("silverPlayerSettings_v2", JSON.stringify(settings));
}

function loadSettings() {
    let saved = localStorage.getItem("silverPlayerSettings_v2");
    if (!saved) return;
    try {
        let s = JSON.parse(saved);
        volumeEnhance = s.volumeEnhance || 0.7;
        boostLevel = s.boostLevel || 1;
        bassLevelVal = s.bassLevelVal || 0;
        reverbSliderValue = s.reverbSliderValue || 0.3;
        audio.volume = s.volume || 0.7;
        volumeProgress.style.width = (100 * audio.volume) + "%";
        document.getElementById("volumeEnhancementSlider").value = 100 * volumeEnhance;
        document.getElementById("volumeValue").innerText = Math.round(100 * volumeEnhance) + "%";
        document.getElementById("boostEnhancementSlider").value = 50 * (boostLevel - 1);
        document.getElementById("boostIndicator").innerText = "x" + boostLevel.toFixed(1);
        document.getElementById("bassEnhancementSlider").value = bassLevelVal / 24 * 100;
        document.getElementById("bassValue").innerText = Math.round(bassLevelVal / 24 * 100) + "%";
        document.getElementById("reverb").value = 100 * reverbSliderValue;
        document.getElementById("reverbValue").innerText = Math.round(100 * reverbSliderValue) + "%";
        if (wetGain) wetGain.gain.value = 1.2 * reverbSliderValue;

        if (s.eqValues && Array.isArray(s.eqValues) && s.eqValues.length === GRAPHIC_EQ_BANDS) {
            eqValues = s.eqValues;
            if (filters && filters.length === GRAPHIC_EQ_BANDS) {
                filters.forEach((f, i) => { f.gain.value = eqValues[i]; });
            }
            updateEqPoints();
            drawEqCanvas();
        }
        applyBoostSettings();
    } catch (e) { console.warn("إعدادات غير صالحة"); }
}

// إعدادات إضافية
document.getElementById("reverb").oninput = e => { reverbSliderValue = e.target.value / 100; document.getElementById("reverbValue").innerText = e.target.value + "%"; if (wetGain) wetGain.gain.value = 1.2 * reverbSliderValue; saveSettings(); };
document.getElementById("playbackSpeed").oninput = e => { audio.playbackRate = e.target.value / 100; document.getElementById("speedValue").innerText = e.target.value + "%"; };
document.getElementById("volumeEnhancementSlider").oninput = e => { volumeEnhance = e.target.value / 100; document.getElementById("volumeValue").innerText = e.target.value + "%"; applyBoostSettings(); };
document.getElementById("boostEnhancementSlider").oninput = e => { boostLevel = 1 + 2 * (e.target.value / 100); document.getElementById("boostIndicator").innerText = "x" + boostLevel.toFixed(1); applyBoostSettings(); boostActive = boostLevel > 1.1; boostChip.classList.toggle("active-chip", boostActive); };
document.getElementById("bassEnhancementSlider").oninput = e => { bassLevelVal = 24 * (e.target.value / 100); document.getElementById("bassValue").innerText = e.target.value + "%"; applyBoostSettings(); };

// اختصارات لوحة المفاتيح
document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    switch (e.key) {
        case " ": e.preventDefault(); playPauseBtn.click(); break;
        case "ArrowRight": nextBtn.click(); break;
        case "ArrowLeft": prevBtn.click(); break;
        case "ArrowUp": audio.volume = Math.min(1, audio.volume + 0.05); volumeProgress.style.width = (100 * audio.volume) + "%"; volumeEnhance = audio.volume; applyBoostSettings(); break;
        case "ArrowDown": audio.volume = Math.max(0, audio.volume - 0.05); volumeProgress.style.width = (100 * audio.volume) + "%"; volumeEnhance = audio.volume; applyBoostSettings(); break;
        case "r": repeatBtn.click(); break;
        case "s": shuffleBtn.click(); break;
        case "b": boostChip.click(); break;
        case "c": cameraToggleChip.click(); break;
        case "p": powerSaveChip.click(); break;
        case "t": palaceToggleChip.click(); break;
        case "h": advancedToggleChip.click(); break;
    }
});

// ========== السحب والإفلات ==========
document.addEventListener("dragenter", e => { document.body.classList.add("drag-over"); dropOverlay.classList.add("show"); });
document.addEventListener("dragleave", e => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) { document.body.classList.remove("drag-over"); dropOverlay.classList.remove("show"); } });
document.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation();
    document.body.classList.remove("drag-over"); dropOverlay.classList.remove("show");
    let files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    let audioFiles = [], lyricsFile = null;
    const audioExts = ["mp3","wav","ogg","aac","flac","m4a","opus"];
    const lyricsExts = ["srt","lrc","txt"];
    for (let file of files) {
        let ext = file.name.split(".").pop().toLowerCase();
        if (audioExts.includes(ext)) audioFiles.push(file);
        else if (lyricsExts.includes(ext) && !lyricsFile) lyricsFile = file;
    }
    if (audioFiles.length) addSongs(audioFiles);
    if (lyricsFile) {
        let reader = new FileReader();
        reader.onload = function(ev) { processLyricsFile(ev.target.result, lyricsFile.name); };
        reader.readAsText(lyricsFile, "UTF-8");
    }
});

// ========== النجوم ==========
function createStars() {
    let container = document.getElementById("starsBackground");
    for (let i = 0; i < 120; i++) {
        let star = document.createElement("div");
        star.classList.add("star");
        star.style.width = star.style.height = (Math.random() * 3 + 1) + "px";
        star.style.left = Math.random() * 100 + "%";
        star.style.top = Math.random() * 100 + "%";
        star.style.animationDelay = Math.random() * 4 + "s";
        container.appendChild(star);
    }
}
createStars();

// ========== التهيئة النهائية ==========
switchUIMode();
enableSlow3D(false);

for (let i = 0; i < 20; i++) {
    let bar = document.createElement("div");
    bar.classList.add("bar");
    visualizerDiv.appendChild(bar);
}
visualizerBars = document.querySelectorAll(".bar");

refreshPlaylist();
updatePlaylistCount();
loadSettings();
initGraphicEQ();

if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => { if (!isPlaying) playPauseBtn.click(); });
    navigator.mediaSession.setActionHandler("pause", () => { if (isPlaying) playPauseBtn.click(); });
    navigator.mediaSession.setActionHandler("previoustrack", () => prevBtn.click());
    navigator.mediaSession.setActionHandler("nexttrack", () => nextBtn.click());
}

})();
