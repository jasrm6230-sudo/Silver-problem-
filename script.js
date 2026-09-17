/* ============================================================
   المشغل الفضي الفاخر — script.js
   نسخة مُصححة ومُحسّنة (كامل)
   ============================================================ */
(function () {
    "use strict";

    /* ============================================================
       (1) الثوابت العامة
       ============================================================ */
    const GRAPHIC_EQ_BANDS = 18;
    const EQ_MIN_DB = -12;
    const EQ_MAX_DB = 12;

    // 18 باند مرتّبة تصاعديًا 32Hz → 20kHz (بدون تكرار)
    const EQ_FREQS = [
        32, 50, 80, 125, 200, 315, 500, 800, 1200,
        2000, 3150, 5000, 8000, 10000, 12500, 16000, 18000, 20000
    ];
    const EQ_LABELS = [
        '32', '50', '80', '125', '200', '315', '500', '800', '1.2k',
        '2k', '3.15k', '5k', '8k', '10k', '12.5k', '16k', '18k', '20k'
    ];

    const MAX_RESUME_ATTEMPTS = 3;
    const RESUME_INTERVAL = 10000;

    /* ============================================================
       (2) دوال مساعدة
       ============================================================ */

    function parseTime(str) {
        if (typeof str !== "string") return NaN;
        const t = str.trim().replace(",", ".").split(":");
        let val;
        if (t.length === 3) {
            val = 3600 * parseFloat(t[0]) + 60 * parseFloat(t[1]) + parseFloat(t[2]);
        } else if (t.length === 2) {
            val = 60 * parseFloat(t[0]) + parseFloat(t[1]);
        } else {
            val = parseFloat(t[0]);
        }
        return isNaN(val) ? NaN : val;
    }

    // إصلاح: معامل القسمة حسب عدد أرقام الكسر (10^length)
    function parseLRC(content) {
        const lines = content.split(/\r?\n/);
        const entries = [];
        const regex = /\[(\d{2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
        for (const line of lines) {
            regex.lastIndex = 0;
            let match;
            const times = [];
            while ((match = regex.exec(line)) !== null) {
                const minutes = parseInt(match[1], 10);
                const seconds = parseInt(match[2], 10);
                let frac = 0;
                if (match[3]) {
                    frac = parseInt(match[3], 10) / Math.pow(10, match[3].length);
                }
                times.push(60 * minutes + seconds + frac);
            }
            const text = line.replace(/\[\d{2}:\d{2}(?:[.:]\d{1,3})?\]/g, "").trim();
            if (times.length > 0 && text !== "") {
                for (const t of times) entries.push({ time: t, text });
            }
        }
        return entries.sort((a, b) => a.time - b.time);
    }

    function convertLRCtoSRTlike(lrcEntries, fallbackDuration) {
        const cues = [];
        for (let i = 0; i < lrcEntries.length; i++) {
            const start = lrcEntries[i].time;
            let end = (i + 1 < lrcEntries.length) ? lrcEntries[i + 1].time : start + fallbackDuration;
            if (end - start > 15) end = start + 5;
            cues.push({ start, end, text: lrcEntries[i].text });
        }
        return cues;
    }

    function loadLyricsData(content, fileName, audioDuration) {
        const nameLower = fileName.toLowerCase();
        const fallbackDuration = (audioDuration && isFinite(audioDuration) && audioDuration > 0)
            ? audioDuration : 300;

        if (nameLower.endsWith(".lrc") || nameLower.endsWith(".txt")) {
            const lrcEntries = parseLRC(content);
            if (lrcEntries.length === 0) return false;
            const cues = convertLRCtoSRTlike(lrcEntries, fallbackDuration);
            return { cues, words: parseSRTtoWords(cues), content, fileName };
        }

        const blocks = content.split(/\r?\n\r?\n/);
        const cues = [];
        for (const block of blocks) {
            const lines = block.split(/\r?\n/);
            if (lines.length < 2) continue;
            const timingLine = lines[1];
            if (!timingLine.includes("-->")) continue;
            const parts = timingLine.split("-->");
            if (parts.length !== 2) continue;
            const start = parseTime(parts[0]);
            const end = parseTime(parts[1]);
            // إصلاح: تجاهل التوقيتات غير الصالحة
            if (isNaN(start) || isNaN(end)) continue;
            const text = lines.slice(2).join(" ").replace(/<[^>]*>/g, "").trim();
            if (text) cues.push({ start, end, text });
        }
        if (cues.length === 0) return false;
        return { cues, words: parseSRTtoWords(cues), content, fileName };
    }

    function parseSRTtoWords(cues) {
        const words = [];
        for (const cue of cues) {
            const tokens = cue.text.split(/\s+/);
            if (tokens.length === 0) continue;
            const durPerWord = (cue.end - cue.start) / tokens.length;
            for (let i = 0; i < tokens.length; i++) {
                const word = tokens[i].replace(/[،,.;؟!]/g, "");
                if (word.length > 0) words.push({ time: cue.start + i * durPerWord, word });
            }
        }
        return words.sort((a, b) => a.time - b.time);
    }

    function formatTime(sec) {
        if (isNaN(sec)) return "0:00";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ":" + (s < 10 ? "0" : "") + s;
    }

    function showToast(msg) {
        const existing = document.querySelector(".toast");
        if (existing) existing.remove();
        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    // إصلاح: debounce للحفظ لتجنب الكتابة المستمرة في localStorage
    let _saveTimer = null;
    function scheduleSave() {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(saveSettings, 300);
    }

    /* ============================================================
       (3) الحالة العامة
       ============================================================ */
    const audio = new Audio();
    let songs = [];
    let currentIndex = 0;
    let isPlaying = false;
    let isRepeating = false;
    let isShuffling = false;
    let isCameraRotating = false;
    let rotationAngle = 0;
    let cameraId = null;
    let audioContext = null;
    let source = null;
    let gainNode = null;
    let analyser = null;
    let filters = [];
    let isAudioInitialized = false;
    let volumeEnhance = 0.7;
    let boostLevel = 1;
    let boostActive = false;
    let wetGain = null;
    let dryGain = null;
    let mixGain = null;
    let convolverNode = null;
    let reverbSliderValue = 0.3;
    let palaceEnabled = false;
    let visualizerBars = [];
    let visualizerAnimId = null;
    let spectrumAnimId = null;
    let waveDrawAnimationId = null;
    let waveformLoopActive = false;
    let autoResumeEnabled = true;
    let userPaused = false;
    let resumeTimeout = null;
    let resumeAttempts = 0;
    let powerSave = false;

    const songLyricsMap = new Map();
    let allObjectURLs = [];
    let srtCues = [];
    let wordTimeline = [];
    let rawLyricsContent = null;
    let rawLyricsFileName = null;
    let currentMode = "word";
    let lastStageIndex = -1;
    let stageTransitionTimeout = null;

    // إصلاح الأداء: مؤشرات متزايدة بدل المرور على كامل المصفوفة
    let _lastWordIdx = -1;
    let _lastCueIdx = -1;

    // Graphic EQ
    let eqValues = new Array(GRAPHIC_EQ_BANDS).fill(0);
    let eqCanvas = null;
    let eqCtx = null;
    let eqPoints = [];
    let activeEqIndex = -1;

    const eqPresets = {
        flat:       [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        bass:       [ 6, 5, 4, 3, 2, 1, 0,-1,-1, 0, 1, 1, 0, 0, 0, 0, 0, 0],
        vocal:      [-2,-1, 0, 1, 2, 3, 3, 2, 1, 0, 0,-1,-2,-2,-2,-1,-1, 0],
        rock:       [ 4, 4, 3, 2, 1, 0, 1, 2, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0],
        electronic: [ 5, 5, 3, 1, 0,-1, 0, 1, 2, 3, 3, 2, 1, 1, 0, 0, 0, 0]
    };

    /* ============================================================
       (4) عناصر DOM
       ============================================================ */
    const playPauseBtn     = document.getElementById("playPauseBtn");
    const prevBtn          = document.getElementById("prevBtn");
    const nextBtn          = document.getElementById("nextBtn");
    const repeatBtn        = document.getElementById("repeatBtn");
    const shuffleBtn       = document.getElementById("shuffleBtn");
    const currentTimeSpan  = document.getElementById("currentTime");
    const durationSpan     = document.getElementById("duration");
    const volumeSlider     = document.getElementById("volumeSlider");
    const volumeProgress   = document.getElementById("volumeProgress");
    const fileInput        = document.getElementById("fileInput");
    const playlistDiv      = document.getElementById("playlist");
    const songTitleSpan    = document.getElementById("songTitle");
    const songArtistSpan   = document.getElementById("songArtist");
    const albumImage       = document.getElementById("albumImage");
    const albumContainer   = document.getElementById("albumArtContainer");
    const loadingOverlay   = document.getElementById("loadingOverlay");
    const lyricsWordDiv    = document.getElementById("lyricsWord");
    const stageContainer   = document.getElementById("stageContainer");
    const prevWordDiv      = document.getElementById("prevWord");
    const currentWordDiv   = document.getElementById("currentWord");
    const nextWordDiv      = document.getElementById("nextWord");
    const srtInput         = document.getElementById("srtInput");
    const clearSrtBtn      = document.getElementById("clearSrtBtn");
    const toggleModeBtn    = document.getElementById("toggleModeBtn");
    const srtStatusMsg     = document.getElementById("srtStatusMsg");
    const waveformCanvas   = document.getElementById("waveformCanvas");
    const waveformContainer= document.getElementById("waveformContainer");
    const waveformClickTarget = document.getElementById("waveformClickTarget");
    const visualizerDiv    = document.getElementById("visualizer");
    const spectrumCanvas   = document.getElementById("spectrumCanvas");
    const ctx              = spectrumCanvas.getContext("2d");
    const advancedSection  = document.getElementById("advancedSection");
    const advancedToggleChip = document.getElementById("advancedToggleChip");
    const palaceControls   = document.getElementById("palaceEffectControls");
    const playerSection    = document.getElementById("playerSection");
    const dropOverlay      = document.getElementById("dropOverlay");
    const burgerMenuBtn    = document.getElementById("burgerMenuBtn");
    const burgerDropdown   = document.getElementById("burgerDropdown");
    const playlistCountSpan= document.getElementById("playlistCount");
    const musicPlayerContainer = document.getElementById("musicPlayerContainer");
    const eqTooltip        = document.getElementById("eqTooltip");
    const resetEqBtn       = document.getElementById("resetEqBtn");

    let waveformCtx = waveformCanvas.getContext("2d");
    let waveformData = null;
    let advancedPanelVisible = true;

    /* ============================================================
       (5) Media Session — يُسجَّل مرة واحدة فقط
       ============================================================ */
    function initMediaSessionHandlers() {
        if (!("mediaSession" in navigator)) return;
        const safeSet = (action, handler) => {
            try { navigator.mediaSession.setActionHandler(action, handler); }
            catch (_) { /* بعض المتصفحات لا تدعم كل الأزرار */ }
        };
        safeSet("play",          () => { if (!isPlaying) playPauseBtn.click(); });
        safeSet("pause",         () => { if (isPlaying)  playPauseBtn.click(); });
        safeSet("previoustrack", () => prevBtn.click());
        safeSet("nexttrack",     () => nextBtn.click());
    }

    function updateMediaSession() {
        if (!("mediaSession" in navigator)) return;
        const song = songs[currentIndex];
        if (!song) { navigator.mediaSession.metadata = null; return; }
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title:  song.title  || "أغنية غير معروفة",
                artist: song.artist || "فنان فضي",
                album:  "المشغل الفضي",
                artwork: song.cover
                    ? [{ src: song.cover, sizes: "200x200", type: "image/png" }]
                    : []
            });
        } catch (_) {}
    }

    /* ============================================================
       (6) الموجة الصوتية (Waveform)
       ============================================================ */
    function resizeWaveformCanvas() {
        const rect = waveformContainer.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        waveformCanvas.width  = rect.width  * dpr;
        waveformCanvas.height = rect.height * dpr;
        waveformCtx.setTransform(1, 0, 0, 1, 0, 0);
        waveformCtx.scale(dpr, dpr);
        if (waveformData) drawWaveform();
    }

    window.addEventListener("resize", () => {
        resizeWaveformCanvas();
        if (waveformData) drawWaveform();
    });

    setTimeout(resizeWaveformCanvas, 100);

    function extractWaveformData(buffer) {
        const data = buffer.getChannelData(0);
        const width = waveformCanvas.width;
        const step = Math.max(1, Math.floor(data.length / width));
        const peaks = [];
        for (let i = 0; i < width; i++) {
            const start = step * i;
            const end = Math.min(start + step, data.length);
            let max = 0;
            for (let j = start; j < end; j++) {
                const v = Math.abs(data[j]);
                if (v > max) max = v;
            }
            peaks.push(max);
        }
        const globalMax = Math.max(...peaks, 0.001);
        return peaks.map(p => p / globalMax);
    }

    // إصلاح: استخدام OfflineAudioContext عند عدم وجود سياق رئيسي
    async function loadAudioBuffer(url) {
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const decodeCtx = audioContext || new OfflineAudioContext(1, 1, 44100);
            const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
            waveformData = extractWaveformData(audioBuffer);
            drawWaveform(0, audio.duration || 1);
        } catch (err) {
            console.warn("تعذر تحميل الموجة:", err);
            waveformData = null;
        }
    }

    function drawWaveform(currentTime = audio.currentTime || 0, duration = audio.duration || 1) {
        if (!waveformData || !waveformCtx) return;
        const dpr = window.devicePixelRatio || 1;
        const w = waveformCanvas.width / dpr;
        const h = waveformCanvas.height / dpr;
        waveformCtx.clearRect(0, 0, w, h);
        waveformCtx.fillStyle = "#0A0A0D";
        waveformCtx.fillRect(0, 0, w, h);

        const barWidth = w / waveformData.length;
        const centerY  = h / 2;
        const progressX = (currentTime / duration) * w;

        for (let i = 0; i < waveformData.length; i++) {
            const x = i * barWidth;
            const peak = waveformData[i];
            const barHeight = peak * (0.8 * h);
            waveformCtx.fillStyle = x < progressX
                ? "rgba(210,210,240,1)"
                : "rgba(180,180,210,0.7)";
            waveformCtx.fillRect(x, centerY - barHeight / 2, barWidth - 1, barHeight);
        }
        waveformCtx.beginPath();
        waveformCtx.strokeStyle = "#FFFFFF";
        waveformCtx.lineWidth = 2;
        waveformCtx.moveTo(progressX, 0);
        waveformCtx.lineTo(progressX, h);
        waveformCtx.stroke();
    }

    function startWaveformProgress() {
        if (waveformLoopActive) return;
        waveformLoopActive = true;
        function loop() {
            if (!waveformLoopActive) return;
            if (!audio.paused && waveformData && audio.duration) {
                drawWaveform(audio.currentTime, audio.duration);
            }
            waveDrawAnimationId = requestAnimationFrame(loop);
        }
        loop();
    }

    function stopWaveformProgress() {
        waveformLoopActive = false;
        if (waveDrawAnimationId) {
            cancelAnimationFrame(waveDrawAnimationId);
            waveDrawAnimationId = null;
        }
    }

    /* ============================================================
       (7) الاستئناف التلقائي
       ============================================================ */
    function startAutoResume() {
        if (!autoResumeEnabled || !isPlaying || songs.length === 0) return;
        stopAutoResume();
        resumeAttempts = 0;
        attemptResume();
    }

    function attemptResume() {
        if (resumeAttempts >= MAX_RESUME_ATTEMPTS) { stopAutoResume(); return; }
        resumeAttempts++;
        resumeTimeout = setTimeout(async () => {
            if (!userPaused && autoResumeEnabled && songs.length && audio.paused) {
                try {
                    await audio.play();
                    isPlaying = true;
                    playPauseBtn.innerHTML = "⏸️";
                    startAlbumRotation();
                    enableSlow3D(true);
                    startVisualizerLoop();
                    startSpectrumLoop();
                    startWaveformProgress();
                    updateMediaSession();
                    stopAutoResume();
                    showToast("🔄 تم استئناف الموسيقى تلقائياً");
                } catch (_) {
                    attemptResume();
                }
            } else {
                stopAutoResume();
            }
        }, RESUME_INTERVAL);
    }

    function stopAutoResume() {
        if (resumeTimeout) { clearTimeout(resumeTimeout); resumeTimeout = null; }
        resumeAttempts = 0;
    }

    /* ============================================================
       (8) السحب على الموجة للتنقل
       ============================================================ */
    function handleWaveformSeek(clientX) {
        if (audio.duration && waveformData) {
            const rect = waveformContainer.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            audio.currentTime = ratio * audio.duration;
            resetLyricsCache();
            updateLyricsByTime(audio.currentTime);
        }
    }

    waveformClickTarget.addEventListener("click", e => handleWaveformSeek(e.clientX));

    waveformClickTarget.addEventListener("mousedown", e => {
        if (!audio.duration || !waveformData) return;
        const rect = waveformContainer.getBoundingClientRect();
        const onMove = ev => {
            const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
            audio.currentTime = ratio * audio.duration;
            resetLyricsCache();
            updateLyricsByTime(audio.currentTime);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        handleWaveformSeek(e.clientX);
    });

    waveformClickTarget.addEventListener("touchstart", e => {
        if (!audio.duration || !waveformData) return;
        const rect = waveformContainer.getBoundingClientRect();
        const onMove = ev => {
            const ratio = Math.min(1, Math.max(0, (ev.touches[0].clientX - rect.left) / rect.width));
            audio.currentTime = ratio * audio.duration;
            resetLyricsCache();
            updateLyricsByTime(audio.currentTime);
        };
        const onEnd = () => {
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onEnd);
        };
        document.addEventListener("touchmove", onMove, { passive: true });
        document.addEventListener("touchend", onEnd);
        handleWaveformSeek(e.touches[0].clientX);
    }, { passive: true });

    /* ============================================================
       (9) إيماءات اللمس
       ============================================================ */
    let touchStartX = 0, touchStartY = 0, touchHandled = false;

    musicPlayerContainer.addEventListener("touchstart", e => {
        if (e.target.closest(".playlist-item, button, input, label, .waveform-click-target, .volume-slider, canvas")) {
            touchHandled = true;
            return;
        }
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchHandled = false;
    }, { passive: true });

    musicPlayerContainer.addEventListener("touchmove", e => {
        if (touchHandled) return;
        if (Math.abs(e.touches[0].clientY - touchStartY) >= 30) return;
        const diffX = e.touches[0].clientX - touchStartX;
        if (Math.abs(diffX) > 60) {
            touchHandled = true;
            if (diffX < -40) {
                playNext();
                showToast("⏭️ الأغنية التالية");
            } else {
                playPrev();
                showToast("⏮️ الأغنية السابقة");
            }
        }
    }, { passive: true });

    musicPlayerContainer.addEventListener("touchend", () => { touchHandled = false; });

    /* ============================================================
       (10) نظام الكلمات (Lyrics)
       ============================================================ */
    function resetLyricsCache() {
        _lastWordIdx = -1;
        _lastCueIdx  = -1;
        lastStageIndex = -1;
    }

    function updateLyricsByTime(currentTime) {
        if (currentMode === "word") {
            if (!wordTimeline.length) {
                if (lyricsWordDiv.textContent !== "🎤 ارفع SRT/LRC") {
                    lyricsWordDiv.textContent = "🎤 ارفع SRT/LRC";
                }
                return;
            }
            // إصلاح الأداء: مؤشر متزايد
            while (_lastWordIdx + 1 < wordTimeline.length &&
                   wordTimeline[_lastWordIdx + 1].time <= currentTime) {
                _lastWordIdx++;
            }
            while (_lastWordIdx >= 0 && wordTimeline[_lastWordIdx].time > currentTime) {
                _lastWordIdx--;
            }
            const foundWord = _lastWordIdx >= 0 ? wordTimeline[_lastWordIdx].word : null;
            const newText = foundWord || "✨ استعد";
            if (lyricsWordDiv.textContent !== newText) lyricsWordDiv.textContent = newText;

        } else if (currentMode === "sentence") {
            if (!srtCues.length) {
                if (lyricsWordDiv.textContent !== "🎤 ارفع SRT/LRC") {
                    lyricsWordDiv.textContent = "🎤 ارفع SRT/LRC";
                }
                return;
            }
            // مؤشر متزايد
            while (_lastCueIdx + 1 < srtCues.length &&
                   srtCues[_lastCueIdx + 1].start <= currentTime) {
                _lastCueIdx++;
            }
            while (_lastCueIdx >= 0 && srtCues[_lastCueIdx].start > currentTime) {
                _lastCueIdx--;
            }
            let foundCue = null;
            if (_lastCueIdx >= 0) {
                const c = srtCues[_lastCueIdx];
                if (currentTime >= c.start && currentTime <= c.end) foundCue = c;
            }
            let newText = "✨ يترقب";
            if (foundCue) {
                newText = foundCue.text.length > 85
                    ? foundCue.text.substring(0, 85) + "..."
                    : foundCue.text;
            }
            if (lyricsWordDiv.textContent !== newText) lyricsWordDiv.textContent = newText;

        } else if (currentMode === "stage") {
            if (!wordTimeline.length) {
                prevWordDiv.textContent = "";
                currentWordDiv.textContent = "🎤 ارفع SRT/LRC";
                nextWordDiv.textContent = "";
                return;
            }
            while (_lastWordIdx + 1 < wordTimeline.length &&
                   wordTimeline[_lastWordIdx + 1].time <= currentTime) {
                _lastWordIdx++;
            }
            while (_lastWordIdx >= 0 && wordTimeline[_lastWordIdx].time > currentTime) {
                _lastWordIdx--;
            }
            if (_lastWordIdx !== lastStageIndex) {
                updateStageWords(_lastWordIdx);
                lastStageIndex = _lastWordIdx;
            }
        }
    }

    function updateStageWords(index) {
        prevWordDiv.classList.remove("prev-exit");
        currentWordDiv.classList.remove("current-enter");
        nextWordDiv.classList.remove("next-enter");
        void prevWordDiv.offsetWidth;

        const prev = index > 0 ? wordTimeline[index - 1].word : "";
        const curr = (index >= 0 && index < wordTimeline.length) ? wordTimeline[index].word : "🎤";
        const next = (index >= 0 && index < wordTimeline.length - 1) ? wordTimeline[index + 1].word : "";

        if (lastStageIndex === -1) {
            prevWordDiv.textContent = prev;
            currentWordDiv.textContent = curr;
            nextWordDiv.textContent = next;
            prevWordDiv.style.opacity = prev ? "0.45" : "0";
            currentWordDiv.style.opacity = "1";
            nextWordDiv.style.opacity = next ? "0.45" : "0";
            return;
        }
        prevWordDiv.textContent = prev;
        if (prev) prevWordDiv.classList.add("prev-exit");
        else prevWordDiv.style.opacity = "0";

        currentWordDiv.textContent = curr;
        currentWordDiv.classList.add("current-enter");

        nextWordDiv.textContent = next;
        if (next) nextWordDiv.classList.add("next-enter");
        else nextWordDiv.style.opacity = "0";

        if (stageTransitionTimeout) clearTimeout(stageTransitionTimeout);
        stageTransitionTimeout = setTimeout(() => {
            prevWordDiv.classList.remove("prev-exit");
            currentWordDiv.classList.remove("current-enter");
            nextWordDiv.classList.remove("next-enter");
            prevWordDiv.style.opacity = prev ? "0.45" : "0";
            currentWordDiv.style.opacity = "1";
            nextWordDiv.style.opacity = next ? "0.45" : "0";
        }, 500);
    }

    audio.addEventListener("timeupdate", () => {
        if (audio.duration) {
            currentTimeSpan.textContent = formatTime(audio.currentTime);
            durationSpan.textContent = formatTime(audio.duration);
        }
        updateLyricsByTime(audio.currentTime);
    });

    function enableSlow3D(enable) {
        lyricsWordDiv.classList.toggle("rotate-3d-active", enable);
    }

    function switchUIMode() {
        if (currentMode === "stage") {
            lyricsWordDiv.style.visibility = "hidden";
            lyricsWordDiv.style.position = "absolute";
            stageContainer.style.visibility = "visible";
            stageContainer.style.position = "relative";
            [prevWordDiv, currentWordDiv, nextWordDiv].forEach(el =>
                el.classList.remove("prev-exit", "current-enter", "next-enter"));
        } else {
            lyricsWordDiv.style.visibility = "visible";
            lyricsWordDiv.style.position = "relative";
            stageContainer.style.visibility = "hidden";
            stageContainer.style.position = "absolute";
        }
    }

    function toggleMode() {
        if (currentMode === "word") {
            currentMode = "sentence";
            toggleModeBtn.textContent = "🔁 وضع: جملة";
        } else if (currentMode === "sentence") {
            currentMode = "stage";
            toggleModeBtn.textContent = "🔁 وضع: مسرح";
        } else {
            currentMode = "word";
            toggleModeBtn.textContent = "🔁 وضع: كلمة";
        }
        resetLyricsCache();
        switchUIMode();
        enableSlow3D(isPlaying);
        if (!isNaN(audio.currentTime)) updateLyricsByTime(audio.currentTime);
    }

    function clearSRT() {
        const songId = getCurrentSongId();
        if (songId) songLyricsMap.delete(songId);
        srtCues = [];
        wordTimeline = [];
        rawLyricsContent = null;
        rawLyricsFileName = null;
        srtInput.value = "";
        srtStatusMsg.textContent = "تم مسح الترجمة - ارفع SRT أو LRC جديد";
        resetLyricsCache();
        if (currentMode === "stage") {
            prevWordDiv.textContent = "";
            currentWordDiv.textContent = "📄 تم المسح";
            nextWordDiv.textContent = "";
        } else {
            lyricsWordDiv.textContent = "📄 تم المسح";
        }
    }

    function processLyricsFile(content, fileName) {
        const songId = getCurrentSongId();
        const duration = (audio.duration && isFinite(audio.duration) && audio.duration > 0)
            ? audio.duration : 300;
        const result = loadLyricsData(content, fileName, duration);

        if (result && songId) {
            songLyricsMap.set(songId, {
                cues: result.cues,
                words: result.words,
                content,
                fileName
            });
            srtCues = result.cues;
            wordTimeline = result.words;
            rawLyricsContent = content;
            rawLyricsFileName = fileName;
            srtStatusMsg.textContent =
                "✅ تم تحميل وحفظ " + result.cues.length + " مقطع (" + result.words.length + " كلمة) - " + fileName;
            resetLyricsCache();
            if (!isNaN(audio.currentTime)) updateLyricsByTime(audio.currentTime);
        } else if (!songId) {
            srtStatusMsg.textContent = "❌ أضف أغنية أولاً قبل رفع الترجمة";
        } else {
            srtStatusMsg.textContent = "❌ خطأ في تنسيق الملف";
        }
    }

    srtInput.addEventListener("change", e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => processLyricsFile(ev.target.result, file.name);
        reader.readAsText(file, "UTF-8");
    });

    clearSrtBtn.addEventListener("click", clearSRT);
    toggleModeBtn.addEventListener("click", toggleMode);

    function getCurrentSongId() {
        return songs[currentIndex]?.src || null;
    }

    function loadLyricsForCurrentSong() {
        const songId = getCurrentSongId();
        if (songId && songLyricsMap.has(songId)) {
            const saved = songLyricsMap.get(songId);
            srtCues = saved.cues;
            wordTimeline = saved.words;
            rawLyricsContent = saved.content;
            rawLyricsFileName = saved.fileName;
            srtStatusMsg.textContent =
                "✅ ترجمة محفوظة: " + saved.cues.length + " مقطع (" + saved.words.length + " كلمة) - " + saved.fileName;
        } else {
            srtCues = [];
            wordTimeline = [];
            rawLyricsContent = null;
            rawLyricsFileName = null;
            srtStatusMsg.textContent = "🎤 لا توجد ترجمة لهذه الأغنية.";
        }
        resetLyricsCache();
        updateLyricsByTime(audio.currentTime || 0);
        switchUIMode();
    }

    /* ============================================================
       (11) قائمة التشغيل — إصلاح XSS
       ============================================================ */
    function getAudioDuration(file) {
        return new Promise(resolve => {
            const tempAudio = new Audio();
            const url = URL.createObjectURL(file);
            tempAudio.src = url;
            const cleanup = () => URL.revokeObjectURL(url);
            tempAudio.addEventListener("loadedmetadata", () => {
                const dur = tempAudio.duration;
                cleanup();
                resolve(isFinite(dur) && dur > 0 ? dur : 0);
            });
            tempAudio.addEventListener("error", () => {
                cleanup();
                resolve(0);
            });
        });
    }

    function updatePlaylistCount() {
        playlistCountSpan.textContent = songs.length;
    }

    // إصلاح XSS: بناء عناصر DOM بدل innerHTML
    function renderPlaylistItem(index) {
        const song = songs[index];
        const div = document.createElement("div");
        div.className = "playlist-item";
        div.draggable = true;
        div.dataset.index = index;

        const handle = document.createElement("span");
        handle.className = "drag-handle";
        handle.title = "اسحب لإعادة الترتيب";
        handle.textContent = "⋮⋮";

        const idxSpan = document.createElement("span");
        idxSpan.className = "song-index";
        idxSpan.textContent = index + 1;

        const nameSpan = document.createElement("span");
        nameSpan.className = "song-name";
        nameSpan.title = song.title;            // ← لا يُفسَّر HTML
        nameSpan.textContent = song.title;      // ← آمن تمامًا

        const durSpan = document.createElement("span");
        durSpan.className = "song-duration";
        durSpan.textContent = song.duration > 0 ? formatTime(song.duration) : "--:--";

        const delBtn = document.createElement("button");
        delBtn.className = "delete-song-btn";
        delBtn.title = "حذف الأغنية";
        delBtn.dataset.index = index;
        delBtn.textContent = "×";

        div.append(handle, idxSpan, nameSpan, durSpan, delBtn);

        if (index === currentIndex) div.classList.add("active");

        div.addEventListener("click", e => {
            if (!e.target.closest(".delete-song-btn") && !e.target.closest(".drag-handle")) {
                currentIndex = index;
                loadSong(currentIndex);
                if (isPlaying) audio.play().catch(() => {});
                updatePlaylistActive();
            }
        });

        delBtn.addEventListener("click", e => {
            e.stopPropagation();
            deleteSong(index);
        });

        // سحب وإفلات الماوس
        div.addEventListener("dragstart", e => {
            e.dataTransfer.setData("text/plain", index.toString());
            div.classList.add("dragging");
        });
        div.addEventListener("dragend", () => div.classList.remove("dragging"));
        div.addEventListener("dragover", e => {
            e.preventDefault();
            div.classList.add("drag-over");
        });
        div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
        div.addEventListener("drop", e => {
            e.preventDefault();
            div.classList.remove("drag-over");
            const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
            const to = parseInt(div.dataset.index, 10);
            if (!isNaN(from) && !isNaN(to) && from !== to) moveSong(from, to);
        });

        // سحب وإفلات اللمس
        let tStartY = 0;
        handle.addEventListener("touchstart", e => {
            tStartY = e.touches[0].clientY;
            div.style.transition = "none";
        }, { passive: true });

        handle.addEventListener("touchmove", e => {
            const diff = e.touches[0].clientY - tStartY;
            div.style.transform = "translateY(" + diff + "px)";
            div.style.zIndex = "10";
            div.style.opacity = "0.8";
            const items = [...playlistDiv.querySelectorAll(".playlist-item")];
            items.forEach(it => it.classList.remove("drag-over"));
            const target = items.find(it => {
                const r = it.getBoundingClientRect();
                return e.touches[0].clientY >= r.top
                    && e.touches[0].clientY <= r.bottom
                    && it !== div;
            });
            if (target) target.classList.add("drag-over");
        }, { passive: true });

        handle.addEventListener("touchend", e => {
            div.style.transition = "all 0.2s";
            div.style.transform = "";
            div.style.zIndex = "";
            div.style.opacity = "";
            const items = [...playlistDiv.querySelectorAll(".playlist-item")];
            items.forEach(it => it.classList.remove("drag-over"));
            const target = items.find(it => {
                const r = it.getBoundingClientRect();
                return e.changedTouches[0].clientY >= r.top
                    && e.changedTouches[0].clientY <= r.bottom
                    && it !== div;
            });
            if (target) {
                const from = parseInt(div.dataset.index, 10);
                const to = parseInt(target.dataset.index, 10);
                if (!isNaN(from) && !isNaN(to) && from !== to) moveSong(from, to);
            }
        });

        return div;
    }

    function refreshPlaylist() {
        playlistDiv.innerHTML = "";
        if (songs.length === 0) {
            const empty = document.createElement("div");
            empty.className = "playlist-empty";
            empty.textContent = "🎵 لا توجد أغانٍ - أضف ملفات موسيقية";
            playlistDiv.appendChild(empty);
        } else {
            const frag = document.createDocumentFragment();
            songs.forEach((_, i) => frag.appendChild(renderPlaylistItem(i)));
            playlistDiv.appendChild(frag);
        }
        updatePlaylistCount();
    }

    function updatePlaylistActive() {
        const items = playlistDiv.querySelectorAll(".playlist-item");
        items.forEach((item, i) => {
            item.classList.toggle("active", i === currentIndex);
        });
    }

    function deleteSong(index) {
        if (index < 0 || index >= songs.length) return;
        const song = songs[index];
        const currentSrc = songs[currentIndex]?.src;
        if (song.src && song.src !== currentSrc && allObjectURLs.includes(song.src)) {
            URL.revokeObjectURL(song.src);
            allObjectURLs = allObjectURLs.filter(u => u !== song.src);
        }
        if (song.src) songLyricsMap.delete(song.src);

        songs.splice(index, 1);

        if (songs.length === 0) {
            currentIndex = 0;
            audio.src = "";
            songTitleSpan.textContent = "🎵 أضف موسيقى";
            songArtistSpan.textContent = "فنان فضي";
            albumImage.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%232A2A38'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='20' fill='%23E8E8F2'%3Eغلاف%3C/text%3E%3C/svg%3E";
            waveformData = null;
            drawWaveform(0, 1);
            srtCues = [];
            wordTimeline = [];
            resetLyricsCache();
            updateMediaSession();
        } else {
            if (index < currentIndex) currentIndex--;
            if (currentIndex >= songs.length) currentIndex = songs.length - 1;
            loadSong(currentIndex);
            if (isPlaying) audio.play().catch(() => {});
        }
        refreshPlaylist();
        updatePlaylistActive();
        showToast("🗑 تم حذف الأغنية");
    }

    function moveSong(from, to) {
        if (from === to) return;
        const item = songs.splice(from, 1)[0];
        songs.splice(to, 0, item);
        if (currentIndex === from) currentIndex = to;
        else if (from < currentIndex && to >= currentIndex) currentIndex--;
        else if (from > currentIndex && to <= currentIndex) currentIndex++;
        refreshPlaylist();
        updatePlaylistActive();
    }

    function clearAllPlaylist() {
        if (songs.length === 0) return;
        if (!confirm("هل أنت متأكد من مسح قائمة التشغيل بالكامل؟")) return;

        const currentSrc = songs[currentIndex]?.src;
        for (const song of songs) {
            if (song.src && song.src !== currentSrc && allObjectURLs.includes(song.src)) {
                URL.revokeObjectURL(song.src);
            }
        }
        allObjectURLs = allObjectURLs.filter(u => u === currentSrc);
        songLyricsMap.clear();

        songs = [];
        currentIndex = 0;
        userPaused = true;
        stopAutoResume();
        audio.pause();
        isPlaying = false;
        playPauseBtn.innerHTML = "▶️";
        stopAlbumRotation();
        enableSlow3D(false);
        stopVisualizerLoop();
        stopSpectrumLoop();
        stopWaveformProgress();

        songTitleSpan.textContent = "🎵 أضف موسيقى";
        songArtistSpan.textContent = "فنان فضي";
        waveformData = null;
        srtCues = [];
        wordTimeline = [];
        resetLyricsCache();
        updateMediaSession();
        refreshPlaylist();
        updatePlaylistActive();
        showToast("🗑 تم مسح قائمة التشغيل");
    }

    function exportPlaylist() {
        if (songs.length === 0) { showToast("⚠️ لا توجد أغانٍ للتصدير"); return; }
        const data = songs.map((s, i) => ({
            index: i, title: s.title, artist: s.artist, duration: s.duration
        }));
        const json = JSON.stringify({
            version: 1,
            exportedAt: new Date().toISOString(),
            songs: data
        }, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "playlist-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        a.click();
        URL.revokeObjectURL(url);
        showToast("💾 تم تصدير قائمة التشغيل");
    }

    function importPlaylist(file) {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.songs || !Array.isArray(data.songs)) throw new Error("تنسيق غير صالح");
                showToast("📥 تم استيراد " + data.songs.length + " أغنية (بيانات مرجعية فقط)");
                alert("تم استيراد بيانات قائمة التشغيل.\nملاحظة: لا يمكن استعادة الملفات الصوتية الفعلية، يجب إعادة إضافتها يدويًا.");
            } catch (_) {
                showToast("❌ فشل استيراد الملف: تنسيق غير صالح");
            }
        };
        reader.readAsText(file, "UTF-8");
    }

    async function addSongs(files) {
        if (!files || files.length === 0) return;
        showLoading();
        let addedCount = 0;
        for (const file of files) {
            try {
                if (!file || file.size === 0) continue;
                const url = URL.createObjectURL(file);
                const duration = await getAudioDuration(file);
                allObjectURLs.push(url);
                songs.push({
                    title: file.name.replace(/\.[^/.]+$/, ""),
                    artist: "فنان فضي",
                    src: url,
                    cover: "",
                    duration
                });
                addedCount++;
            } catch (err) {
                console.warn("خطأ أثناء إضافة ملف:", file.name, err);
            }
        }
        refreshPlaylist();
        if (songs.length > 0 && !audio.src) {
            currentIndex = 0;
            loadSong(0);
            if (!isAudioInitialized) await initAudioContext();
            updatePlaylistActive();
        }
        updatePlaylistCount();
        hideLoading();
        if (addedCount > 0) showToast("✅ تمت إضافة " + addedCount + " أغنية");
        else showToast("⚠️ لم يتم إضافة أي ملفات صالحة");
    }

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
        albumImage.src = songs[index].cover ||
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%232A2A38'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='20' fill='%23E8E8F2'%3Eغلاف%3C/text%3E%3C/svg%3E";
        waveformData = null;
        if (songs[index].src) loadAudioBuffer(songs[index].src);
        loadLyricsForCurrentSong();
        updateMediaSession();

        audio.oncanplay = () => hideLoading();
        audio.onerror = () => {
            hideLoading();
            srtStatusMsg.textContent = "⚠️ خطأ في تحميل الملف الصوتي";
        };
        if (isPlaying) {
            audio.play().catch(() => {});
            enableSlow3D(true);
        } else {
            enableSlow3D(false);
        }
        resetLyricsCache();
        updateLyricsByTime(0);
        setTimeout(() => { if (waveformData) drawWaveform(0, audio.duration || 1); }, 300);
        updatePlaylistActive();

        if (songs[index].duration <= 0 && audio.duration && !isNaN(audio.duration)) {
            songs[index].duration = audio.duration;
            refreshPlaylist();
            updatePlaylistActive();
        }
    }

    function playNext() {
        if (!songs.length) return;
        if (isShuffling) {
            let next;
            do { next = Math.floor(Math.random() * songs.length); }
            while (next === currentIndex && songs.length > 1);
            currentIndex = next;
        } else {
            currentIndex++;
            if (currentIndex >= songs.length) currentIndex = 0;
        }
        loadSong(currentIndex);
        if (isPlaying) audio.play().catch(() => {});
        updatePlaylistActive();
    }

    function playPrev() {
        if (!songs.length) return;
        currentIndex--;
        if (currentIndex < 0) currentIndex = songs.length - 1;
        loadSong(currentIndex);
        if (isPlaying) audio.play().catch(() => {});
        updatePlaylistActive();
    }

    /* ============================================================
       (12) نظام الصوت والمعادل
       ============================================================ */
    function applyBoostSettings() {
        if (!gainNode) return;
        gainNode.gain.value = volumeEnhance * boostLevel;
        if (filters.length === GRAPHIC_EQ_BANDS) {
            for (let i = 0; i < GRAPHIC_EQ_BANDS; i++) {
                if (filters[i]) filters[i].gain.value = eqValues[i];
            }
        }
        scheduleSave();
    }

    function createReverbBuffer(ctx, duration = 2.8, decay = 3.5) {
        const sampleRate = ctx.sampleRate;
        const length = Math.floor(sampleRate * duration);
        const buffer = ctx.createBuffer(2, length, sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const channel = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                const t = i / sampleRate;
                const envelope = Math.exp(-t * decay);
                const noise = (Math.random() * 2 - 1) * 0.6 * envelope;
                let impulse = (i === 0) ? 1 : noise;
                if (ch === 1 && i > 0.07 * sampleRate) {
                    impulse += channel[i - Math.floor(0.07 * sampleRate)] * 0.35;
                }
                channel[i] = Math.max(-1, Math.min(1, impulse * envelope)) * 0.9;
            }
        }
        return buffer;
    }

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

            // إصلاح: استخدام EQ_FREQS الموحّد
            filters = EQ_FREQS.map((freq, i) => {
                const filter = audioContext.createBiquadFilter();
                if (i === 0) filter.type = "lowshelf";
                else if (i === EQ_FREQS.length - 1) filter.type = "highshelf";
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
            wetGain = audioContext.createGain();
            dryGain = audioContext.createGain();
            mixGain = audioContext.createGain();
            wetGain.gain.value = 1.2 * reverbSliderValue;
            dryGain.gain.value = 0.8;

            currentNode.connect(dryGain);
            dryGain.connect(mixGain);
            currentNode.connect(convolverNode);
            convolverNode.connect(wetGain);
            wetGain.connect(mixGain);
            mixGain.connect(analyser);
            analyser.connect(audioContext.destination);

            isAudioInitialized = true;
            applyBoostSettings();
            loadSettings();
            startSpectrumLoop();
            startVisualizerLoop();
        } catch (e) {
            console.error("فشل تهيئة الصوت:", e);
        }
    }

    function startSpectrumLoop() {
        if (!analyser || spectrumAnimId) return;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function loop() {
            if (!analyser || !spectrumCanvas) return;
            analyser.getByteFrequencyData(dataArray);
            const w = spectrumCanvas.clientWidth;
            const h = spectrumCanvas.clientHeight;
            if (spectrumCanvas.width !== w) spectrumCanvas.width = w;
            if (spectrumCanvas.height !== h) spectrumCanvas.height = h;
            ctx.clearRect(0, 0, w, h);
            for (let i = 0; i < 80; i++) {
                const freq = 20 * Math.pow(1000, i / 79);
                let bin = Math.floor(freq / (audioContext.sampleRate / 2) * analyser.frequencyBinCount);
                bin = Math.min(analyser.frequencyBinCount - 1, Math.max(0, bin));
                const value = dataArray[bin] / 255;
                const barHeight = value * h;
                const r = 100 + 155 * value;
                ctx.fillStyle = "rgb(" + Math.round(r) + "," + Math.round(r - 40) + ",240)";
                ctx.fillRect(i * (w / 80), h - barHeight, w / 80 - 1.5, barHeight);
            }
            spectrumAnimId = requestAnimationFrame(loop);
        }
        loop();
    }

    function stopSpectrumLoop() {
        if (spectrumAnimId) { cancelAnimationFrame(spectrumAnimId); spectrumAnimId = null; }
    }

    function startVisualizerLoop() {
        if (!analyser || visualizerAnimId) return;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function loop() {
            if (!analyser || !isPlaying) { visualizerAnimId = null; return; }
            analyser.getByteFrequencyData(dataArray);
            for (let i = 0; i < visualizerBars.length; i++) {
                const bin = Math.floor(i / visualizerBars.length * analyser.frequencyBinCount);
                const val = dataArray[bin] / 255 * 45 + 5;
                visualizerBars[i].style.height = val + "px";
                const intensity = val / 50;
                const c = Math.round(180 + 75 * intensity);
                visualizerBars[i].style.background =
                    "linear-gradient(to top, #8A8AA8, rgb(" + c + "," + c + ",255))";
            }
            visualizerAnimId = requestAnimationFrame(loop);
        }
        loop();
    }

    function stopVisualizerLoop() {
        if (visualizerAnimId) { cancelAnimationFrame(visualizerAnimId); visualizerAnimId = null; }
    }

    /* ============================================================
       (13) أزرار التحكم الأساسية
       ============================================================ */
    playPauseBtn.onclick = async () => {
        if (!songs.length) { alert("أضف أغاني أولاً"); return; }
        if (!isAudioInitialized) await initAudioContext();

        if (isPlaying) {
            userPaused = true;
            stopAutoResume();
            audio.pause();
            playPauseBtn.innerHTML = "▶️";
            stopAlbumRotation();
            enableSlow3D(false);
            stopVisualizerLoop();
            stopSpectrumLoop();
            stopWaveformProgress();
        } else {
            userPaused = false;
            if (audioContext && audioContext.state === "suspended") {
                try { await audioContext.resume(); } catch (_) {}
            }
            try {
                await audio.play();
                playPauseBtn.innerHTML = "⏸️";
                startAlbumRotation();
                enableSlow3D(true);
                startVisualizerLoop();
                startSpectrumLoop();
                startWaveformProgress();
            } catch (err) {
                console.warn("تعذر التشغيل:", err);
                showToast("⚠️ تعذر بدء التشغيل");
            }
        }
        isPlaying = !isPlaying;
        updateMediaSession();
    };

    audio.addEventListener("ended", () => {
        if (isRepeating) {
            audio.currentTime = 0;
            audio.play().catch(() => {});
        } else {
            playNext();
        }
    });

    audio.addEventListener("pause", () => {
        if (!userPaused && autoResumeEnabled && isPlaying && songs.length) {
            startAutoResume();
        }
    });

    audio.addEventListener("play", () => {
        userPaused = false;
        stopAutoResume();
    });

    volumeSlider.addEventListener("click", e => {
        const rect = volumeSlider.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        audio.volume = ratio;
        volumeProgress.style.width = (100 * ratio) + "%";
        volumeEnhance = ratio;
        applyBoostSettings();
    });

    repeatBtn.onclick = () => {
        isRepeating = !isRepeating;
        repeatBtn.classList.toggle("active", isRepeating);
    };
    shuffleBtn.onclick = () => {
        isShuffling = !isShuffling;
        shuffleBtn.classList.toggle("active", isShuffling);
    };
    nextBtn.onclick = () => { playNext(); };
    prevBtn.onclick = () => { playPrev(); };

    /* ============================================================
       (14) رقاقات الشريط العلوي
       ============================================================ */
    const boostChip = document.getElementById("boostChip");
    boostChip.onclick = () => {
        boostActive = !boostActive;
        boostLevel = boostActive ? 1.8 : 1;
        boostChip.classList.toggle("active-chip", boostActive);
        applyBoostSettings();
        const slider = document.getElementById("boostEnhancementSlider");
        if (slider) slider.value = 50 * (boostLevel - 1);
        const indicator = document.getElementById("boostIndicator");
        if (indicator) indicator.textContent = "x" + boostLevel.toFixed(1);
    };

    const powerSaveChip = document.getElementById("powerSaveChip");
    powerSaveChip.onclick = () => {
        powerSave = !powerSave;
        document.body.classList.toggle("power-save-mode", powerSave);
        powerSaveChip.classList.toggle("active-chip", powerSave);
        if (powerSave) {
            if (isCameraRotating) cameraToggleChip.click();
            stopAlbumRotation();
            stopVisualizerLoop();
            stopSpectrumLoop();
        } else if (isPlaying) {
            startVisualizerLoop();
            startSpectrumLoop();
            startAlbumRotation();
        }
    };

    const cameraToggleChip = document.getElementById("cameraToggleChip");
    cameraToggleChip.onclick = () => {
        if (powerSave) { showToast("وضع توفير الطاقة مفعّل"); return; }
        isCameraRotating = !isCameraRotating;
        if (isCameraRotating) {
            cameraToggleChip.classList.add("active-chip");
            cameraToggleChip.textContent = "⏹️";
            const rotate = () => {
                if (!isCameraRotating) return;
                rotationAngle += 0.6;
                playerSection.style.transform = "rotateY(" + rotationAngle + "deg) rotateX(4deg)";
                cameraId = requestAnimationFrame(rotate);
            };
            rotate();
        } else {
            if (cameraId) cancelAnimationFrame(cameraId);
            playerSection.style.transform = "none";
            cameraToggleChip.classList.remove("active-chip");
            cameraToggleChip.textContent = "🎥";
        }
    };

    const palaceToggleChip = document.getElementById("palaceToggleChip");
    palaceToggleChip.onclick = () => {
        palaceEnabled = !palaceEnabled;
        palaceControls.style.display = palaceEnabled ? "block" : "none";
        palaceToggleChip.classList.toggle("palace-active", palaceEnabled);
    };

    advancedToggleChip.onclick = () => {
        advancedPanelVisible = !advancedPanelVisible;
        advancedSection.classList.toggle("hidden-panel", !advancedPanelVisible);
        advancedToggleChip.classList.toggle("active-chip", advancedPanelVisible);
    };

    /* ============================================================
       (15) المودالات والقائمة الجانبية
       ============================================================ */
    const infoChip = document.getElementById("infoChip");
    const infoModal = document.getElementById("infoModal");
    const closeInfoModalBtn = document.getElementById("closeInfoModal");
    infoChip.onclick = () => infoModal.classList.add("open");
    closeInfoModalBtn.onclick = () => infoModal.classList.remove("open");
    infoModal.addEventListener("click", e => {
        if (e.target === infoModal) infoModal.classList.remove("open");
    });

    const shortcutsFab = document.getElementById("shortcutsFab");
    const shortcutsModal = document.getElementById("shortcutsModal");
    const closeShortcutsModalBtn = document.getElementById("closeShortcutsModal");
    shortcutsFab.onclick = () => shortcutsModal.classList.add("open");
    closeShortcutsModalBtn.onclick = () => shortcutsModal.classList.remove("open");
    shortcutsModal.addEventListener("click", e => {
        if (e.target === shortcutsModal) shortcutsModal.classList.remove("open");
    });

    document.getElementById("fullscreenFab").onclick = () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
    };

    burgerMenuBtn.addEventListener("click", e => {
        e.stopPropagation();
        burgerDropdown.classList.toggle("open");
        burgerMenuBtn.classList.toggle("active");
    });

    document.addEventListener("click", e => {
        if (!burgerDropdown.contains(e.target) && !burgerMenuBtn.contains(e.target)) {
            burgerDropdown.classList.remove("open");
            burgerMenuBtn.classList.remove("active");
        }
    });

    burgerDropdown.querySelectorAll(".dropdown-item").forEach(item => {
        item.addEventListener("click", () => {
            const action = item.dataset.action;
            burgerDropdown.classList.remove("open");
            burgerMenuBtn.classList.remove("active");
            if (action === "camera") cameraToggleChip.click();
            else if (action === "palace") palaceToggleChip.click();
            else if (action === "boost") boostChip.click();
            else if (action === "powersave") powerSaveChip.click();
            else if (action === "advanced") advancedToggleChip.click();
            else if (action === "info") infoChip.click();
            else if (action === "shortcuts") shortcutsFab.click();
        });
    });

    document.getElementById("exportPlaylistBtn").addEventListener("click", exportPlaylist);
    document.getElementById("importPlaylistBtn").addEventListener("click",
        () => document.getElementById("importPlaylistInput").click());
    document.getElementById("importPlaylistInput").addEventListener("change", e => {
        if (e.target.files[0]) { importPlaylist(e.target.files[0]); e.target.value = ""; }
    });
    document.getElementById("clearPlaylistBtn").addEventListener("click", clearAllPlaylist);

    fileInput.addEventListener("change", e => {
        if (e.target.files && e.target.files.length > 0) {
            addSongs(Array.from(e.target.files));
            fileInput.value = "";
        }
    });

    document.getElementById("imageInput").addEventListener("change", e => {
        if (!e.target.files[0]) return;
        const reader = new FileReader();
        reader.onload = ev => {
            albumImage.src = ev.target.result;
            if (songs[currentIndex]) songs[currentIndex].cover = ev.target.result;
            updateMediaSession();
        };
        reader.readAsDataURL(e.target.files[0]);
    });

    /* ============================================================
       (16) تأثيرات القصر
       ============================================================ */
    document.getElementById("applyPalaceEffect").addEventListener("click", () => {
        const size = parseFloat(document.getElementById("palaceSize").value) / 100;
        if (wetGain && dryGain) {
            wetGain.gain.value = Math.min(1.3, reverbSliderValue + 0.9 * size);
            dryGain.gain.value = Math.max(0.4, 0.8 - 0.25 * size);
            document.getElementById("palaceStatus").textContent =
                "🏰 قصر نشط: صدى " + Math.round(100 * wetGain.gain.value) + "%";
        }
    });

    document.getElementById("resetPalaceEffect").addEventListener("click", () => {
        if (wetGain && dryGain) {
            wetGain.gain.value = 1.2 * reverbSliderValue;
            dryGain.gain.value = 0.8;
            document.getElementById("palaceStatus").textContent = "تم إعادة التعيين";
        }
    });

    document.getElementById("palaceSize").addEventListener("input", e => {
        document.getElementById("palaceSizeValue").textContent = e.target.value + "%";
    });

    /* ============================================================
       (17) المعادل الرسومي (Graphic EQ)
       ============================================================ */
    function initGraphicEQ() {
        eqCanvas = document.getElementById("graphicEqCanvas");
        if (!eqCanvas) return;
        eqCtx = eqCanvas.getContext("2d");

        const labelsContainer = document.querySelector(".eq-grid-labels");
        if (labelsContainer) {
            labelsContainer.innerHTML = "";
            // إصلاح: لا نعكس التسميات — bass على اليمين في RTL
            EQ_LABELS.forEach(lbl => {
                const span = document.createElement("span");
                span.textContent = lbl;
                labelsContainer.appendChild(span);
            });
        }

        function resizeCanvas() {
            const wrapper = eqCanvas.parentElement;
            const rect = wrapper.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            eqCanvas.width = rect.width * dpr;
            eqCanvas.height = 200 * dpr;
            eqCanvas.style.width = rect.width + "px";
            eqCanvas.style.height = "200px";
            eqCtx.setTransform(1, 0, 0, 1, 0, 0);
            eqCtx.scale(dpr, dpr);
            updateEqPoints();
            drawEqCanvas();
        }

        window.addEventListener("resize", resizeCanvas);
        resizeCanvas();

        eqCanvas.addEventListener("mousedown", onEqMouseDown);
        window.addEventListener("mousemove", onEqMouseMove);
        window.addEventListener("mouseup", onEqMouseUp);
        eqCanvas.addEventListener("touchstart", onEqTouchStart, { passive: false });
        eqCanvas.addEventListener("touchmove", onEqTouchMove, { passive: false });
        eqCanvas.addEventListener("touchend", onEqTouchEnd);
        eqCanvas.addEventListener("touchcancel", onEqTouchEnd);

        document.querySelectorAll(".preset-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const preset = btn.dataset.preset;
                if (eqPresets[preset]) {
                    setEqValues(eqPresets[preset]);
                    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
                    btn.classList.add("active");
                    scheduleSave();
                }
            });
        });

        if (resetEqBtn) {
            resetEqBtn.addEventListener("click", () => {
                setEqValues(eqPresets.flat);
                document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
                const flatBtn = document.querySelector('.preset-btn[data-preset="flat"]');
                if (flatBtn) flatBtn.classList.add("active");
                scheduleSave();
            });
        }
    }

    function setEqValues(values) {
        if (!values || values.length !== GRAPHIC_EQ_BANDS) return;
        eqValues = [...values];
        if (filters && filters.length === GRAPHIC_EQ_BANDS) {
            filters.forEach((f, i) => { f.gain.value = eqValues[i]; });
        }
        syncBassSliderFromEq();
        updateEqPoints();
        drawEqCanvas();
    }

    function syncBassSliderFromEq() {
        const bassSlider = document.getElementById("bassEnhancementSlider");
        const bassValueSpan = document.getElementById("bassValue");
        if (!bassSlider || !bassValueSpan) return;
        const bassPercent = Math.round((Math.max(0, eqValues[0]) / (EQ_MAX_DB * 2)) * 100);
        bassSlider.value = bassPercent;
        bassValueSpan.textContent = bassPercent + "%";
    }

    function updateEqPoints() {
        if (!eqCanvas) return;
        const w = eqCanvas.width / (window.devicePixelRatio || 1);
        const h = 200;
        const padX = 30, padY = 25;
        const gW = w - padX * 2;
        const gH = h - padY * 2;

        eqPoints = eqValues.map((db, i) => {
            // bass (index 0) على اليمين
            const x = padX + gW - (i / (GRAPHIC_EQ_BANDS - 1)) * gW;
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
        const gW = w - padX * 2;
        const gH = h - padY * 2;

        eqCtx.clearRect(0, 0, w, h);
        eqCtx.fillStyle = "#09090D";
        eqCtx.fillRect(padX, padY, gW, gH);

        eqCtx.strokeStyle = "rgba(200,200,220,0.08)";
        eqCtx.lineWidth = 1;
        eqCtx.font = '9px "Segoe UI"';
        eqCtx.fillStyle = "#888";
        for (let db = EQ_MIN_DB; db <= EQ_MAX_DB; db += 3) {
            const y = padY + gH - ((db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * gH;
            eqCtx.beginPath();
            eqCtx.moveTo(padX, y);
            eqCtx.lineTo(w - padX, y);
            eqCtx.stroke();
            eqCtx.textAlign = "left";
            eqCtx.fillText(db + "dB", 4, y + 3);
        }

        if (eqPoints.length < 2) return;

        eqCtx.beginPath();
        eqCtx.strokeStyle = "#E8E8F2";
        eqCtx.lineWidth = 2.8;
        eqCtx.shadowColor = "rgba(232,232,242,0.7)";
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
            eqCtx.fillStyle = (i === activeEqIndex) ? "#FFFFFF" : "#D0D0F0";
            eqCtx.fill();
            eqCtx.strokeStyle = "#1A1A28";
            eqCtx.lineWidth = 2;
            eqCtx.stroke();
        });
    }

    function yToDb(canvasY) {
        const h = 200, padY = 25, gH = h - padY * 2;
        let norm = 1 - (canvasY - padY) / gH;
        norm = Math.min(1, Math.max(0, norm));
        const db = EQ_MIN_DB + norm * (EQ_MAX_DB - EQ_MIN_DB);
        return Math.round(db * 2) / 2;
    }

    function findClosestPoint(clientX, clientY) {
        const rect = eqCanvas.getBoundingClientRect();
        const scaleX = (eqCanvas.width / (window.devicePixelRatio || 1)) / rect.width;
        const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height;
        const mx = (clientX - rect.left) * scaleX;
        const my = (clientY - rect.top) * scaleY;
        let minDist = Infinity, idx = -1;
        eqPoints.forEach((p, i) => {
            const dx = p.x - mx, dy = p.y - my;
            const dist = dx * dx + dy * dy;
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
        if (index === 0) syncBassSliderFromEq();
    }

    function onEqMouseDown(e) {
        const idx = findClosestPoint(e.clientX, e.clientY);
        if (idx !== -1) {
            activeEqIndex = idx;
            showEqTooltip(e.clientX, e.clientY, eqValues[idx]);
            drawEqCanvas();
            e.preventDefault();
        }
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

    function onEqMouseUp() {
        if (activeEqIndex !== -1) {
            hideEqTooltip();
            activeEqIndex = -1;
            drawEqCanvas();
            scheduleSave();
        }
    }

    function onEqTouchStart(e) {
        e.preventDefault();
        const t = e.touches[0];
        const idx = findClosestPoint(t.clientX, t.clientY);
        if (idx !== -1) {
            activeEqIndex = idx;
            showEqTooltip(t.clientX, t.clientY, eqValues[idx]);
            drawEqCanvas();
        }
    }

    function onEqTouchMove(e) {
        e.preventDefault();
        if (activeEqIndex === -1) return;
        const t = e.touches[0];
        const rect = eqCanvas.getBoundingClientRect();
        const scaleY = (eqCanvas.height / (window.devicePixelRatio || 1)) / rect.height;
        const canvasY = (t.clientY - rect.top) * scaleY;
        const newDb = yToDb(canvasY);
        updateSingleBand(activeEqIndex, newDb);
        showEqTooltip(t.clientX, t.clientY, newDb);
    }

    function onEqTouchEnd() {
        if (activeEqIndex !== -1) {
            hideEqTooltip();
            activeEqIndex = -1;
            drawEqCanvas();
            scheduleSave();
        }
    }

    function showEqTooltip(clientX, clientY, db) {
        if (!eqTooltip) return;
        const rect = eqCanvas.getBoundingClientRect();
        eqTooltip.textContent = (db > 0 ? "+" : "") + db.toFixed(1) + " dB";
        eqTooltip.style.left = (clientX - rect.left) + "px";
        eqTooltip.style.top = (clientY - rect.top - 35) + "px";
        eqTooltip.style.display = "block";
    }

    function hideEqTooltip() {
        if (eqTooltip) eqTooltip.style.display = "none";
    }

    /* ============================================================
       (18) الإعدادات (حفظ/تحميل)
       ============================================================ */
    function saveSettings() {
        try {
            const settings = {
                volumeEnhance,
                boostLevel,
                reverbSliderValue,
                eqValues: [...eqValues],
                volume: audio.volume
            };
            localStorage.setItem("silverPlayerSettings_v2", JSON.stringify(settings));
        } catch (_) { /* quota exceeded - تجاهل */ }
    }

    function loadSettings() {
        const saved = localStorage.getItem("silverPlayerSettings_v2");
        if (!saved) return;
        try {
            const s = JSON.parse(saved);
            if (typeof s.volumeEnhance === "number") volumeEnhance = s.volumeEnhance;
            if (typeof s.boostLevel === "number") boostLevel = s.boostLevel;
            if (typeof s.reverbSliderValue === "number") reverbSliderValue = s.reverbSliderValue;
            if (typeof s.volume === "number") audio.volume = s.volume;

            volumeProgress.style.width = (100 * audio.volume) + "%";

            const vESlider = document.getElementById("volumeEnhancementSlider");
            const vVSpan = document.getElementById("volumeValue");
            if (vESlider) vESlider.value = 100 * volumeEnhance;
            if (vVSpan) vVSpan.textContent = Math.round(100 * volumeEnhance) + "%";

            const bESlider = document.getElementById("boostEnhancementSlider");
            const bISpan = document.getElementById("boostIndicator");
            if (bESlider) bESlider.value = 50 * (boostLevel - 1);
            if (bISpan) bISpan.textContent = "x" + boostLevel.toFixed(1);

            const rSlider = document.getElementById("reverb");
            const rSpan = document.getElementById("reverbValue");
            if (rSlider) rSlider.value = 100 * reverbSliderValue;
            if (rSpan) rSpan.textContent = Math.round(100 * reverbSliderValue) + "%";
            if (wetGain) wetGain.gain.value = 1.2 * reverbSliderValue;

            if (Array.isArray(s.eqValues) && s.eqValues.length === GRAPHIC_EQ_BANDS) {
                eqValues = s.eqValues.slice();
                if (filters && filters.length === GRAPHIC_EQ_BANDS) {
                    filters.forEach((f, i) => { f.gain.value = eqValues[i]; });
                }
                updateEqPoints();
                drawEqCanvas();
                syncBassSliderFromEq();
            }
            applyBoostSettings();
        } catch (e) {
            console.warn("إعدادات غير صالحة:", e);
        }
    }

    /* ============================================================
       (19) شرائط التحكم
       ============================================================ */
    document.getElementById("reverb").oninput = e => {
        reverbSliderValue = parseFloat(e.target.value) / 100;
        document.getElementById("reverbValue").textContent = e.target.value + "%";
        if (wetGain) wetGain.gain.value = 1.2 * reverbSliderValue;
        scheduleSave();
    };

    document.getElementById("playbackSpeed").oninput = e => {
        audio.playbackRate = e.target.value / 100;
        document.getElementById("speedValue").textContent = e.target.value + "%";
    };

    document.getElementById("volumeEnhancementSlider").oninput = e => {
        volumeEnhance = e.target.value / 100;
        document.getElementById("volumeValue").textContent = e.target.value + "%";
        applyBoostSettings();
    };

    document.getElementById("boostEnhancementSlider").oninput = e => {
        boostLevel = 1 + 2 * (e.target.value / 100);
        document.getElementById("boostIndicator").textContent = "x" + boostLevel.toFixed(1);
        applyBoostSettings();
        boostActive = boostLevel > 1.1;
        boostChip.classList.toggle("active-chip", boostActive);
    };

    document.getElementById("bassEnhancementSlider").oninput = e => {
        const percent = parseInt(e.target.value, 10);
        const db = (percent / 100) * (EQ_MAX_DB * 2);
        eqValues[0] = db;
        if (filters && filters[0]) filters[0].gain.value = db;
        document.getElementById("bassValue").textContent = percent + "%";
        updateEqPoints();
        drawEqCanvas();
        scheduleSave();
    };

    /* ============================================================
       (20) اختصارات لوحة المفاتيح
       ============================================================ */
    document.addEventListener("keydown", e => {
        const tag = (e.target.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        switch (e.key) {
            case " ": e.preventDefault(); playPauseBtn.click(); break;
            case "ArrowRight": nextBtn.click(); break;
            case "ArrowLeft": prevBtn.click(); break;
            case "ArrowUp":
                audio.volume = Math.min(1, audio.volume + 0.05);
                volumeProgress.style.width = (100 * audio.volume) + "%";
                volumeEnhance = audio.volume;
                applyBoostSettings();
                break;
            case "ArrowDown":
                audio.volume = Math.max(0, audio.volume - 0.05);
                volumeProgress.style.width = (100 * audio.volume) + "%";
                volumeEnhance = audio.volume;
                applyBoostSettings();
                break;
            case "r": case "R": repeatBtn.click(); break;
            case "s": case "S": shuffleBtn.click(); break;
            case "b": case "B": boostChip.click(); break;
            case "c": case "C": cameraToggleChip.click(); break;
            case "p": case "P": powerSaveChip.click(); break;
            case "t": case "T": palaceToggleChip.click(); break;
            case "h": case "H": advancedToggleChip.click(); break;
        }
    });

    /* ============================================================
       (21) السحب والإفلات على الصفحة
       ============================================================ */
    let dragCounter = 0;

    document.addEventListener("dragenter", e => {
        e.preventDefault();
        dragCounter++;
        document.body.classList.add("drag-over");
        dropOverlay.classList.add("show");
    });

    document.addEventListener("dragleave", e => {
        dragCounter = Math.max(0, dragCounter - 1);
        if (dragCounter === 0) {
            document.body.classList.remove("drag-over");
            dropOverlay.classList.remove("show");
        }
    });

    document.addEventListener("dragover", e => {
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener("drop", e => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        document.body.classList.remove("drag-over");
        dropOverlay.classList.remove("show");

        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;

        const audioFiles = [];
        let lyricsFile = null;
        const audioExts  = ["mp3","wav","ogg","aac","flac","m4a","opus"];
        const lyricsExts = ["srt","lrc","txt"];

        for (const file of files) {
            const ext = file.name.split(".").pop().toLowerCase();
            if (audioExts.includes(ext)) audioFiles.push(file);
            else if (lyricsExts.includes(ext) && !lyricsFile) lyricsFile = file;
        }
        if (audioFiles.length) addSongs(audioFiles);
        if (lyricsFile) {
            const reader = new FileReader();
            reader.onload = ev => processLyricsFile(ev.target.result, lyricsFile.name);
            reader.readAsText(lyricsFile, "UTF-8");
        }
    });

    /* ============================================================
       (22) النجوم
       ============================================================ */
    function createStars() {
        const container = document.getElementById("starsBackground");
        if (!container) return;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 120; i++) {
            const star = document.createElement("div");
            star.classList.add("star");
            const size = (Math.random() * 3 + 1) + "px";
            star.style.width = size;
            star.style.height = size;
            star.style.left = Math.random() * 100 + "%";
            star.style.top = Math.random() * 100 + "%";
            star.style.animationDelay = (Math.random() * 4) + "s";
            frag.appendChild(star);
        }
        container.appendChild(frag);
    }

    /* ============================================================
       (23) التهيئة النهائية
       ============================================================ */
    function init() {
        switchUIMode();
        enableSlow3D(false);

        // أعمدة الفيجوالايزر
        for (let i = 0; i < 20; i++) {
            const bar = document.createElement("div");
            bar.classList.add("bar");
            visualizerDiv.appendChild(bar);
        }
        visualizerBars = document.querySelectorAll(".bar");

        refreshPlaylist();
        updatePlaylistCount();
        initGraphicEQ();
        // ملاحظة: loadSettings يُستدعى داخل initAudioContext بعد تهيئة الـ filters
        // لكن نستدعي هنا أيضًا لتحميل قيم الصوت الأساسية إن لم يكن السياق جاهزًا
        loadSettings();
        createStars();
        initMediaSessionHandlers();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
