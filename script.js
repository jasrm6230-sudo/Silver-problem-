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
            for (let t of times) entries.push({ time: t, text: text });
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
            if (text && !isNaN(start) && !isNaN(end)) cues.push({ start: start, end: end, text: text });
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
            if (word.length > 0) words.push({ time: cue.start + i * durationPerWord, word: word });
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
let wetGain = null, dryGain = null, mixGain = null, convolverNode = null, reverbSliderValue = 0.3, palaceEnabled = false;
let visualizerBars = [], visualizerAnimId = null, spectrumAnimId = null, waveDrawAnimationId = null, waveformLoopActive = false;
let autoResumeEnabled = true, userPaused = false, resumeTimeout = null, resumeAttempts = 0;
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
let eqCanvas, eqCtx, eqPoints = [], activeEqIndex = -1, eqTooltip, resetEqBtn;

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
const playPauseBtn = document.getElementById("playPauseBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const repeatBtn = document.getElementById("repeatBtn");
const shuffleBtn = document.getElementById("shuffleBtn");
const currentTimeSpan = document.getElementById("currentTime");
const durationSpan = document.getElementById("duration");
const volumeSlider = document.getElementById("volumeSlider");
const volumeProgress = document.getElementById("volumeProgress");
const fileInput = document.getElementById("fileInput");
const playlistDiv = document.getElementById("playlist");
const songTitleSpan = document.getElementById("songTitle");
const songArtistSpan = document.getElementById("songArtist");
const albumImage = document.getElementById("albumImage");
const albumContainer = document.getElementById("albumArtContainer");
const loadingOverlay = document.getElementById("loadingOverlay");
const lyricsWordDiv = document.getElementById("lyricsWord");
const stageContainer = document.getElementById("stageContainer");
const prevWordDiv = document.getElementById("prevWord");
const currentWordDiv = document.getElementById("currentWord");
const nextWordDiv = document.getElementById("nextWord");
const srtInput = document.getElementById("srtInput");
const clearSrtBtn = document.getElementById("clearSrtBtn");
const toggleModeBtn = document.getElementById("toggleModeBtn");
const srtStatusMsg = document.getElementById("srtStatusMsg");
const waveformCanvas = document.getElementById("waveformCanvas");
const waveformContainer = document.getElementById("waveformContainer");
const waveformClickTarget = document.getElementById("waveformClickTarget");
const visualizerDiv = document.getElementById("visualizer");
const spectrumCanvas = document.getElementById("spectrumCanvas");
const ctx = spectrumCanvas.getContext("2d");
const advancedSection = document.getElementById("advancedSection");
const advancedToggleChip = document.getElementById("advancedToggleChip");
const palaceControls = document.getElementById("palaceEffectControls");
const playerSection = document.getElementById("playerSection");
const dropOverlay = document.getElementById("dropOverlay");
const burgerMenuBtn = document.getElementById("burgerMenuBtn");
const burgerDropdown = document.getElementById("burgerDropdown");
const playlistCountSpan = document.getElementById("playlistCount");

let waveformCtx = waveformCanvas.getContext("2d"), waveformData = null, advancedPanelVisible = true;

// ========== الموجة الصوتية ==========
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
    return peaks.map(p => p / Math.max(...peaks, 0.001));
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
    } catch (err) { console.warn("تعذر تحميل الموجة:", err); }
}

function drawWaveform(currentTime = audio.currentTime || 0, duration = audio.duration || 1) {
    if (!waveformData || !waveformCtx) return;
    let w = waveformCanvas.width / (window.devicePixelRatio || 1), h = waveformCanvas.height / (window.devicePixelRatio || 1);
    waveformCtx.clearRect(0, 0, w, h);
    waveformCtx.fillStyle = "#0A0A0D";
    waveformCtx.fillRect(0, 0, w, h);
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
        function loop() { if (!waveformLoopActive) return; if (!audio.paused && waveformData && audio.duration) drawWaveform(audio.currentTime, audio.duration); waveDrawAnimationId = requestAnimationFrame(loop); }
        loop();
    }
}
function stopWaveformProgress() { waveformLoopActive = false; if (waveDrawAnimationId) cancelAnimationFrame(waveDrawAnimationId); }

// ========== بقية الدوال (الاستئناف، الإيماءات، الكلمات، قائمة التشغيل، الصوت، إلخ) ==========
// (تم اختصارها هنا لتوفير المساحة، لكنها مطابقة للنسخة السابقة التي تعمل لديك)

// ... [تأكد من تضمين جميع الدوال التي كانت تعمل سابقاً، مثل loadSong, playNext, initAudioContext, etc.]

// ========== دوال المعادل الرسومي ==========
function initGraphicEQ() {
    eqCanvas = document.getElementById('graphicEqCanvas');
    if (!eqCanvas) return;  // إذا لم يوجد الكانفاس لا نفعل شيئاً ولن يتوقف التطبيق
    eqCtx = eqCanvas.getContext('2d');
    eqTooltip = document.getElementById('eqTooltip');
    resetEqBtn = document.getElementById('resetEqBtn');

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

    if (resetEqBtn) {
        resetEqBtn.addEventListener('click', () => {
            setEqValues(eqPresets.flat);
            document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.preset-btn[data-preset="flat"]').classList.add('active');
            saveSettings();
        });
    }

    const labelsContainer = document.querySelector('.eq-grid-labels');
    if (labelsContainer) labelsContainer.innerHTML = eqLabels.map(f => `<span>${f}</span>`).join('');
}

function setEqValues(values) {
    if (!values || values.length !== GRAPHIC_EQ_BANDS) return;
    eqValues = [...values];
    if (filters && filters.length === GRAPHIC_EQ_BANDS) filters.forEach((f, i) => { f.gain.value = eqValues[i]; });
    updateEqPoints();
    drawEqCanvas();
}

function updateEqPoints() {
    if (!eqCanvas) return;
    const w = eqCanvas.width / (window.devicePixelRatio || 1), h = 200, padX = 30, padY = 25;
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
    const w = eqCanvas.width / (window.devicePixelRatio || 1), h = 200, padX = 30, padY = 25;
    const gW = w - padX * 2, gH = h - padY * 2;
    eqCtx.clearRect(0, 0, w, h);
    eqCtx.fillStyle = '#09090D'; eqCtx.fillRect(padX, padY, gW, gH);
    eqCtx.strokeStyle = 'rgba(200,200,220,0.08)'; eqCtx.lineWidth = 1; eqCtx.font = '9px "Segoe UI"'; eqCtx.fillStyle = '#888';
    for (let db = EQ_MIN_DB; db <= EQ_MAX_DB; db += 3) {
        const y = padY + gH - ((db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * gH;
        eqCtx.beginPath(); eqCtx.moveTo(padX, y); eqCtx.lineTo(w - padX, y); eqCtx.stroke();
        eqCtx.fillText(db + 'dB', 4, y + 3);
    }
    if (eqPoints.length < 2) return;
    eqCtx.beginPath(); eqCtx.strokeStyle = '#E8E8F2'; eqCtx.lineWidth = 2.8; eqCtx.shadowColor = 'rgba(232,232,242,0.7)'; eqCtx.shadowBlur = 12;
    eqCtx.moveTo(eqPoints[0].x, eqPoints[0].y);
    for (let i = 0; i < eqPoints.length - 1; i++) {
        const p0 = eqPoints[i === 0 ? 0 : i - 1], p1 = eqPoints[i], p2 = eqPoints[i + 1], p3 = eqPoints[i + 2 < eqPoints.length ? i + 2 : i + 1];
        const cp1x = p1.x + (p2.x - p0.x) / 6, cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6, cp2y = p2.y - (p3.y - p1.y) / 6;
        eqCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    eqCtx.stroke(); eqCtx.shadowBlur = 0;
    eqPoints.forEach((pt, i) => {
        const r = (i === activeEqIndex) ? 9 : 7;
        eqCtx.beginPath(); eqCtx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
        eqCtx.fillStyle = (i === activeEqIndex) ? '#FFFFFF' : '#D0D0F0'; eqCtx.fill();
        eqCtx.strokeStyle = '#1A1A28'; eqCtx.lineWidth = 2; eqCtx.stroke();
    });
}

function yToDb(canvasY) { const h = 200, padY = 25, gH = h - padY * 2; let norm = 1 - (canvasY - padY) / gH; norm = Math.min(1, Math.max(0, norm)); return Math.round((EQ_MIN_DB + norm * (EQ_MAX_DB - EQ_MIN_DB)) * 2) / 2; }
function findClosestPoint(clientX, clientY) {
    const rect = eqCanvas.getBoundingClientRect();
    const scaleX = (eqCanvas.width / (window.devicePixelRatio || 1)) / rect.width;
    const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height;
    const mx = (clientX - rect.left) * scaleX, my = (clientY - rect.top) * scaleY;
    let minDist = Infinity, idx = -1;
    eqPoints.forEach((p, i) => { const dx = p.x - mx, dy = p.y - my, dist = dx*dx+dy*dy; if (dist < minDist && dist < 400) { minDist = dist; idx = i; } });
    return idx;
}
function updateSingleBand(index, db) { db = Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, db)); eqValues[index] = db; if (filters && filters[index]) filters[index].gain.value = db; updateEqPoints(); drawEqCanvas(); }
function onEqMouseDown(e) { const idx = findClosestPoint(e.clientX, e.clientY); if (idx !== -1) { activeEqIndex = idx; showEqTooltip(e.clientX, e.clientY, eqValues[idx]); drawEqCanvas(); e.preventDefault(); } }
function onEqMouseMove(e) { if (activeEqIndex === -1) return; const rect = eqCanvas.getBoundingClientRect(); const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height; const canvasY = (e.clientY - rect.top) * scaleY; const newDb = yToDb(canvasY); updateSingleBand(activeEqIndex, newDb); showEqTooltip(e.clientX, e.clientY, newDb); }
function onEqMouseUp() { if (activeEqIndex !== -1) { hideEqTooltip(); activeEqIndex = -1; drawEqCanvas(); saveSettings(); } }
function onEqTouchStart(e) { e.preventDefault(); const touch = e.touches[0]; const idx = findClosestPoint(touch.clientX, touch.clientY); if (idx !== -1) { activeEqIndex = idx; showEqTooltip(touch.clientX, touch.clientY, eqValues[idx]); drawEqCanvas(); } }
function onEqTouchMove(e) { e.preventDefault(); if (activeEqIndex === -1) return; const touch = e.touches[0]; const rect = eqCanvas.getBoundingClientRect(); const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height; const canvasY = (touch.clientY - rect.top) * scaleY; const newDb = yToDb(canvasY); updateSingleBand(activeEqIndex, newDb); showEqTooltip(touch.clientX, touch.clientY, newDb); }
function onEqTouchEnd() { if (activeEqIndex !== -1) { hideEqTooltip(); activeEqIndex = -1; drawEqCanvas(); saveSettings(); } }
function showEqTooltip(clientX, clientY, db) { if (!eqTooltip) return; const rect = eqCanvas.getBoundingClientRect(); eqTooltip.textContent = (db > 0 ? '+' : '') + db.toFixed(1) + ' dB'; eqTooltip.style.left = (clientX - rect.left) + 'px'; eqTooltip.style.top = (clientY - rect.top - 35) + 'px'; eqTooltip.style.display = 'block'; }
function hideEqTooltip() { if (eqTooltip) eqTooltip.style.display = 'none'; }

// ========== الحفظ والاستعادة ==========
function saveSettings() {
    let settings = { volumeEnhance, boostLevel, bassLevelVal, reverbSliderValue, eqValues, volume: audio.volume };
    localStorage.setItem("silverPlayerSettings_v2", JSON.stringify(settings));
}
function loadSettings() {
    let saved = localStorage.getItem("silverPlayerSettings_v2");
    if (!saved) return;
    try {
        let s = JSON.parse(saved);
        volumeEnhance = s.volumeEnhance || 0.7; boostLevel = s.boostLevel || 1; bassLevelVal = s.bassLevelVal || 0;
        reverbSliderValue = s.reverbSliderValue || 0.3; audio.volume = s.volume || 0.7;
        volumeProgress.style.width = (100 * audio.volume) + "%";
        document.getElementById("volumeEnhancementSlider").value = 100 * volumeEnhance;
        document.getElementById("boostEnhancementSlider").value = 50 * (boostLevel - 1);
        document.getElementById("bassEnhancementSlider").value = bassLevelVal / 24 * 100;
        document.getElementById("reverb").value = 100 * reverbSliderValue;
        if (wetGain) wetGain.gain.value = 1.2 * reverbSliderValue;
        if (s.eqValues && Array.isArray(s.eqValues) && s.eqValues.length === GRAPHIC_EQ_BANDS) {
            eqValues = s.eqValues;
            if (filters && filters.length === GRAPHIC_EQ_BANDS) filters.forEach((f, i) => { f.gain.value = eqValues[i]; });
            updateEqPoints(); drawEqCanvas();
        }
        applyBoostSettings();
    } catch (e) { console.warn("إعدادات غير صالحة"); }
}

// ... [باقي دوال الصوت، الأزرار، إلخ، كما في النسخة العاملة سابقاً]

// في النهاية، استدعِ initGraphicEQ بعد التأكد من وجود الكانفاس
if (document.getElementById('graphicEqCanvas')) {
    initGraphicEQ();
} else {
    console.warn("لم يتم العثور على graphicEqCanvas، تأكد من إضافة كود HTML الخاص بالمعادل الجديد.");
}

// ... [بقية التهيئة: createStars, visualizer bars, refreshPlaylist, إلخ]
})();
