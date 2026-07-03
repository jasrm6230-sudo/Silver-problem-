(function() {
    // ========== دوال مساعدة ==========
    function parseTime(timeStr) {
        let str = timeStr.trim().replace(',', '.');
        let parts = str.split(':');
        if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        else if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        else return parseFloat(parts[0]);
    }

    function parseLRC(content) {
        const lines = content.split(/\r?\n/);
        const cues = [];
        const timeRegex = /\[(\d{2}):(\d{2})(?:[\.:](\d{1,3}))?\]/g;
        for (let line of lines) {
            let match;
            let times = [];
            while ((match = timeRegex.exec(line)) !== null) {
                let minutes = parseInt(match[1], 10);
                let seconds = parseInt(match[2], 10);
                let fraction = match[3] ? parseInt(match[3], 10) : 0;
                let timeInSeconds = minutes * 60 + seconds + fraction / 100;
                times.push(timeInSeconds);
            }
            let text = line.replace(timeRegex, '').trim();
            if (times.length === 0 || text === "") continue;
            for (let t of times) cues.push({ time: t, text: text });
        }
        cues.sort((a, b) => a.time - b.time);
        return cues;
    }

    function convertLRCtoSRTlike(lrcCues, songDuration = 300) {
        const result = [];
        for (let i = 0; i < lrcCues.length; i++) {
            const start = lrcCues[i].time;
            const end = (i + 1 < lrcCues.length) ? lrcCues[i + 1].time : songDuration;
            result.push({ start, end, text: lrcCues[i].text });
        }
        return result;
    }

    function loadLyricsData(content, fileName, songDur) {
        const lowerName = fileName.toLowerCase();
        if (lowerName.endsWith('.lrc') || lowerName.endsWith('.txt')) {
            const lrcCues = parseLRC(content);
            if (lrcCues.length === 0) return false;
            const srtLike = convertLRCtoSRTlike(lrcCues, songDur);
            return { cues: srtLike, words: parseSRTtoWords(srtLike), content, fileName };
        } else {
            const blocks = content.split(/\r?\n\r?\n/);
            const newCues = [];
            for (let block of blocks) {
                const lines = block.split(/\r?\n/);
                if (lines.length < 2) continue;
                const timeLine = lines[1];
                if (!timeLine.includes('-->')) continue;
                const times = timeLine.split('-->');
                if (times.length !== 2) continue;
                const start = parseTime(times[0]);
                const end = parseTime(times[1]);
                let text = lines.slice(2).join(' ').replace(/<[^>]*>/g, '').trim();
                if (text) newCues.push({ start, end, text });
            }
            if (newCues.length === 0) return false;
            return { cues: newCues, words: parseSRTtoWords(newCues), content, fileName };
        }
    }

    function parseSRTtoWords(cues) {
        const items = [];
        for (let cue of cues) {
            const words = cue.text.split(/\s+/);
            if (words.length === 0) continue;
            const duration = cue.end - cue.start;
            const interval = duration / words.length;
            for (let i = 0; i < words.length; i++) {
                let word = words[i].replace(/[،,.;؟!]/g, '');
                if (word.length === 0) continue;
                items.push({ time: cue.start + i * interval, word: word });
            }
        }
        items.sort((a, b) => a.time - b.time);
        return items;
    }

    function formatTime(sec) {
        if (isNaN(sec)) return "0:00";
        let m = Math.floor(sec / 60),
            s = Math.floor(sec % 60);
        return `${m}:${s<10?'0':''}${s}`;
    }

    function showToast(msg) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    // ========== المتغيرات الأساسية ==========
    const audio = new Audio();
    let songs = [],
        currentIndex = 0,
        isPlaying = false,
        isRepeating = false,
        isShuffling = false;
    let isCameraRotating = false,
        rotationAngle = 0,
        cameraId = null;
    let audioContext, source, gainNode, analyser, filters = [],
        isAudioInitialized = false;
    let volumeEnhance = 0.7,
        boostLevel = 1.0,
        bassLevelVal = 0;
    let wetGain = null,
        dryGain = null,
        mixGain = null,
        convolverNode = null;
    let reverbSliderValue = 0.3;
    let palaceEnabled = false;
    let visualizerBars = [];
    let visualizerAnimId = null;
    let spectrumAnimId = null;
    let waveDrawAnimationId = null;
    let waveformLoopActive = false;

    // ========== نظام الاستئناف التلقائي ==========
    let autoResumeEnabled = true;    // مفعل دائمًا
    let userPaused = false;         // هل المستخدم أوقف التشغيل؟
    let resumeTimeout = null;
    let resumeAttempts = 0;
    const MAX_RESUME_ATTEMPTS = 20; // 20 محاولة × 2 ثانية = 40 ثانية
    const RESUME_INTERVAL = 2000;   // محاولة كل ثانيتين

    const songLyricsMap = new Map();
    let allObjectURLs = [];
    let srtCues = [];
    let wordTimeline = [];
    let rawLyricsContent = null;
    let rawLyricsFileName = null;
    let currentMode = 'word';
    let lastStageIndex = -1;
    let stageTransitionTimeout = null;

    // ========== Media Session API ==========
    function updateMediaSession() {
        if (!('mediaSession' in navigator)) return;
        const song = songs[currentIndex];
        if (!song) {
            navigator.mediaSession.metadata = null;
            return;
        }
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title || 'أغنية غير معروفة',
            artist: song.artist || 'فنان فضي',
            album: 'المشغل الفضي',
            artwork: [{ src: song.cover || '', sizes: '200x200', type: 'image/png' }]
        });
        navigator.mediaSession.setActionHandler('play', () => { if (!isPlaying) playPauseBtn.click(); });
        navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) playPauseBtn.click(); });
        navigator.mediaSession.setActionHandler('previoustrack', () => prevBtn.click());
        navigator.mediaSession.setActionHandler('nexttrack', () => nextBtn.click());
    }

    // ========== عناصر DOM ==========
    const playPauseBtn = document.getElementById('playPauseBtn'),
        prevBtn = document.getElementById('prevBtn'),
        nextBtn = document.getElementById('nextBtn');
    const repeatBtn = document.getElementById('repeatBtn'),
        shuffleBtn = document.getElementById('shuffleBtn');
    const currentTimeSpan = document.getElementById('currentTime'),
        durationSpan = document.getElementById('duration');
    const volumeSlider = document.getElementById('volumeSlider'),
        volumeProgress = document.getElementById('volumeProgress');
    const fileInput = document.getElementById('fileInput'),
        playlistDiv = document.getElementById('playlist');
    const songTitleSpan = document.getElementById('songTitle'),
        songArtistSpan = document.getElementById('songArtist');
    const albumImage = document.getElementById('albumImage'),
        albumContainer = document.getElementById('albumArtContainer');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const lyricsWordDiv = document.getElementById('lyricsWord');
    const stageContainer = document.getElementById('stageContainer');
    const prevWordDiv = document.getElementById('prevWord');
    const currentWordDiv = document.getElementById('currentWord');
    const nextWordDiv = document.getElementById('nextWord');
    const srtInput = document.getElementById('srtInput');
    const clearSrtBtn = document.getElementById('clearSrtBtn');
    const toggleModeBtn = document.getElementById('toggleModeBtn');
    const srtStatusMsg = document.getElementById('srtStatusMsg');
    const waveformCanvas = document.getElementById('waveformCanvas');
    const waveformContainer = document.getElementById('waveformContainer');
    const waveformClickTarget = document.getElementById('waveformClickTarget');
    const visualizerDiv = document.getElementById('visualizer');
    const spectrumCanvas = document.getElementById('spectrumCanvas');
    const ctx = spectrumCanvas.getContext('2d');
    const advancedSection = document.getElementById('advancedSection');
    const advancedToggleChip = document.getElementById('advancedToggleChip');
    const palaceControls = document.getElementById('palaceEffectControls');
    const playerSection = document.getElementById('playerSection');
    const dropOverlay = document.getElementById('dropOverlay');
    const burgerMenuBtn = document.getElementById('burgerMenuBtn');
    const burgerDropdown = document.getElementById('burgerDropdown');
    const playlistCountSpan = document.getElementById('playlistCount');

    let waveformCtx = waveformCanvas.getContext('2d');
    let waveformData = null;
    let advancedPanelVisible = true;

    function resizeWaveformCanvas() {
        const rect = waveformContainer.getBoundingClientRect();
        waveformCanvas.width = rect.width * (window.devicePixelRatio || 1);
        waveformCanvas.height = rect.height * (window.devicePixelRatio || 1);
        waveformCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
        if (waveformData) drawWaveform();
    }
    window.addEventListener('resize', () => { resizeWaveformCanvas(); if (waveformData) drawWaveform(); });
    setTimeout(resizeWaveformCanvas, 100);

    function extractWaveformData(buffer) {
        const rawData = buffer.getChannelData(0);
        const samples = waveformCanvas.width;
        const blockSize = Math.floor(rawData.length / samples);
        const peaks = [];
        for (let i = 0; i < samples; i++) {
            let start = blockSize * i;
            let end = start + blockSize;
            let max = 0;
            for (let j = start; j < end; j++) {
                const val = Math.abs(rawData[j]);
                if (val > max) max = val;
            }
            peaks.push(max);
        }
        const maxPeak = Math.max(...peaks, 0.001);
        return peaks.map(p => p / maxPeak);
    }

    async function loadAudioBuffer(url) {
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const actx = audioContext || new(window.AudioContext || window.webkitAudioContext)();
            if (!audioContext) audioContext = actx;
            const buffer = await actx.decodeAudioData(arrayBuffer);
            waveformData = extractWaveformData(buffer);
            drawWaveform();
        } catch (e) {
            console.warn("تعذر تحميل الموجة:", e);
            waveformData = null;
        }
    }

    function drawWaveform(currentTime = audio.currentTime || 0, duration = audio.duration || 1) {
        if (!waveformData || !waveformCtx) return;
        const w = waveformCanvas.width / (window.devicePixelRatio || 1);
        const h = waveformCanvas.height / (window.devicePixelRatio || 1);
        waveformCtx.clearRect(0, 0, w, h);
        waveformCtx.fillStyle = '#0A0A0D';
        waveformCtx.fillRect(0, 0, w, h);
        const barWidth = w / waveformData.length;
        const centerY = h / 2;
        const playedWidth = (currentTime / duration) * w;
        for (let i = 0; i < waveformData.length; i++) {
            const x = i * barWidth;
            const peak = waveformData[i];
            const barHeight = peak * (h * 0.8);
            waveformCtx.fillStyle = x < playedWidth ? 'rgba(210,210,240,1)' : 'rgba(180,180,210,0.7)';
            waveformCtx.fillRect(x, centerY - barHeight / 2, barWidth - 1, barHeight);
        }
        waveformCtx.beginPath();
        waveformCtx.strokeStyle = '#FFFFFF';
        waveformCtx.lineWidth = 2;
        waveformCtx.moveTo(playedWidth, 0);
        waveformCtx.lineTo(playedWidth, h);
        waveformCtx.stroke();
    }

    function startWaveformProgress() {
        if (waveformLoopActive) return;
        waveformLoopActive = true;
        function update() {
            if (!waveformLoopActive) return;
            if (!audio.paused && waveformData && audio.duration) drawWaveform(audio.currentTime, audio.duration);
            waveDrawAnimationId = requestAnimationFrame(update);
        }
        update();
    }

    function stopWaveformProgress() {
        waveformLoopActive = false;
        if (waveDrawAnimationId) { cancelAnimationFrame(waveDrawAnimationId); waveDrawAnimationId = null; }
    }

    // ========== دوال الاستئناف التلقائي ==========
    function startAutoResume() {
        if (!autoResumeEnabled || !isPlaying || !songs.length) return;
        stopAutoResume(); // إيقاف أي محاولة سابقة
        resumeAttempts = 0;
        attemptResume();
    }

    function attemptResume() {
        if (resumeAttempts >= MAX_RESUME_ATTEMPTS) {
            stopAutoResume();
            console.log("⏹️ توقفت محاولات الاستئناف بعد " + MAX_RESUME_ATTEMPTS + " محاولة");
            return;
        }
        resumeAttempts++;
        resumeTimeout = setTimeout(async () => {
            // نتأكد أن التوقف ما زال خارجيًا ولم يتدخل المستخدم
            if (!userPaused && autoResumeEnabled && songs.length && audio.paused) {
                try {
                    await audio.play();
                    // نجح الاستئناف
                    isPlaying = true;
                    playPauseBtn.innerHTML = '⏸️';
                    startAlbumRotation();
                    enableSlow3D(true);
                    startVisualizerLoop();
                    startSpectrumLoop();
                    startWaveformProgress();
                    updateMediaSession();
                    stopAutoResume();
                    showToast('🔄 تم استئناف الموسيقى تلقائياً');
                    console.log("✅ تم استئناف التشغيل بعد " + resumeAttempts + " محاولة");
                } catch (e) {
                    // ما زال لا يمكن التشغيل، نواصل المحاولة
                    console.log("⏳ محاولة " + resumeAttempts + " فشلت، إعادة المحاولة...");
                    attemptResume();
                }
            } else {
                stopAutoResume();
            }
        }, RESUME_INTERVAL);
    }

    function stopAutoResume() {
        if (resumeTimeout) {
            clearTimeout(resumeTimeout);
            resumeTimeout = null;
        }
        resumeAttempts = 0;
    }

    function handleWaveformSeek(clientX) {
        if (!audio.duration || !waveformData) return;
        const rect = waveformContainer.getBoundingClientRect();
        const x = clientX - rect.left;
        const ratio = Math.min(1, Math.max(0, x / rect.width));
        audio.currentTime = ratio * audio.duration;
        updateLyricsByTime(audio.currentTime);
    }
    waveformClickTarget.addEventListener('click', (e) => handleWaveformSeek(e.clientX));
    waveformClickTarget.addEventListener('mousedown', (e) => {
        if (!audio.duration || !waveformData) return;
        const rect = waveformContainer.getBoundingClientRect();
        const onMouseMove = (moveEvent) => {
            const x = moveEvent.clientX - rect.left;
            const ratio = Math.min(1, Math.max(0, x / rect.width));
            audio.currentTime = ratio * audio.duration;
            updateLyricsByTime(audio.currentTime);
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        handleWaveformSeek(e.clientX);
    });
    waveformClickTarget.addEventListener('touchstart', (e) => {
        if (!audio.duration || !waveformData) return;
        const rect = waveformContainer.getBoundingClientRect();
        const onTouchMove = (moveEvent) => {
            const x = moveEvent.touches[0].clientX - rect.left;
            const ratio = Math.min(1, Math.max(0, x / rect.width));
            audio.currentTime = ratio * audio.duration;
            updateLyricsByTime(audio.currentTime);
        };
        const onTouchEnd = () => {
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
        };
        document.addEventListener('touchmove', onTouchMove, { passive: true });
        document.addEventListener('touchend', onTouchEnd);
        handleWaveformSeek(e.touches[0].clientX);
    });

    // ========== إيماءات اللمس (Swipe) ==========
    let touchStartX = 0,
        touchStartY = 0,
        touchHandled = false;
    const musicPlayerContainer = document.getElementById('musicPlayerContainer');
    musicPlayerContainer.addEventListener('touchstart', (e) => {
        if (e.target.closest('.playlist-item') || e.target.closest('button') || e.target.closest('input') || e.target.closest('label') || e.target.closest('.waveform-click-target') || e.target.closest('.volume-slider')) {
            touchHandled = false;
            return;
        }
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchHandled = false;
    }, { passive: true });
    musicPlayerContainer.addEventListener('touchmove', (e) => {
        if (!touchHandled && Math.abs(e.touches[0].clientY - touchStartY) < 30) {
            const diffX = e.touches[0].clientX - touchStartX;
            if (Math.abs(diffX) > 60) {
                touchHandled = true;
                if (diffX < -40) {
                    playNext();
                    if (isPlaying) audio.play();
                    showToast('⏭️ الأغنية التالية');
                } else if (diffX > 40) {
                    if (songs.length) {
                        currentIndex--;
                        if (currentIndex < 0) currentIndex = songs.length - 1;
                        loadSong(currentIndex);
                        if (isPlaying) audio.play();
                        updatePlaylistActive();
                        showToast('⏮️ الأغنية السابقة');
                    }
                }
            }
        }
    }, { passive: true });
    musicPlayerContainer.addEventListener('touchend', () => { touchHandled = false; });

    // ========== تحديث الكلمات ==========
    function updateLyricsByTime(currentTime) {
        if (currentMode === 'word') {
            if (!wordTimeline.length) { if (lyricsWordDiv.innerText !== '🎤 ارفع SRT/LRC') lyricsWordDiv.innerText = '🎤 ارفع SRT/LRC'; return; }
            let found = null;
            for (let i = 0; i < wordTimeline.length; i++) {
                if (wordTimeline[i].time <= currentTime) found = wordTimeline[i].word;
                else break;
            }
            if (found && lyricsWordDiv.innerText !== found) lyricsWordDiv.innerText = found;
            else if (!found && lyricsWordDiv.innerText !== '✨ استعد') lyricsWordDiv.innerText = '✨ استعد';
        } else if (currentMode === 'sentence') {
            if (!srtCues.length) { if (lyricsWordDiv.innerText !== '🎤 ارفع SRT/LRC') lyricsWordDiv.innerText = '🎤 ارفع SRT/LRC'; return; }
            let active = null;
            for (let cue of srtCues) { if (currentTime >= cue.start && currentTime <= cue.end) { active = cue; break; } }
            if (active) {
                let display = active.text.length > 85 ? active.text.substring(0, 85) + '...' : active.text;
                if (lyricsWordDiv.innerText !== display) lyricsWordDiv.innerText = display;
            } else { if (lyricsWordDiv.innerText !== '✨ يترقب') lyricsWordDiv.innerText = '✨ يترقب'; }
        } else if (currentMode === 'stage') {
            if (!wordTimeline.length) { prevWordDiv.textContent = ''; currentWordDiv.textContent = '🎤 ارفع SRT/LRC'; nextWordDiv.textContent = ''; return; }
            let foundIndex = -1;
            for (let i = 0; i < wordTimeline.length; i++) { if (wordTimeline[i].time <= currentTime) foundIndex = i; else break; }
            if (foundIndex !== lastStageIndex) { updateStageWords(foundIndex); lastStageIndex = foundIndex; }
        }
    }

    function updateStageWords(currentIdx) {
        prevWordDiv.classList.remove('prev-exit'); currentWordDiv.classList.remove('current-enter'); nextWordDiv.classList.remove('next-enter');
        void prevWordDiv.offsetWidth;
        const prevText = currentIdx > 0 ? wordTimeline[currentIdx - 1].word : '';
        const currentText = currentIdx >= 0 && currentIdx < wordTimeline.length ? wordTimeline[currentIdx].word : '🎤';
        const nextText = (currentIdx >= 0 && currentIdx < wordTimeline.length - 1) ? wordTimeline[currentIdx + 1].word : '';
        if (lastStageIndex === -1) {
            prevWordDiv.textContent = prevText; currentWordDiv.textContent = currentText; nextWordDiv.textContent = nextText;
            prevWordDiv.style.opacity = prevText ? '0.45' : '0'; currentWordDiv.style.opacity = '1'; nextWordDiv.style.opacity = nextText ? '0.45' : '0';
            return;
        }
        if (prevText) { prevWordDiv.textContent = prevText; prevWordDiv.classList.add('prev-exit'); } else { prevWordDiv.textContent = ''; prevWordDiv.style.opacity = '0'; }
        currentWordDiv.textContent = currentText; currentWordDiv.classList.add('current-enter');
        if (nextText) { nextWordDiv.textContent = nextText; nextWordDiv.classList.add('next-enter'); } else { nextWordDiv.textContent = ''; nextWordDiv.style.opacity = '0'; }
        if (stageTransitionTimeout) clearTimeout(stageTransitionTimeout);
        stageTransitionTimeout = setTimeout(() => {
            prevWordDiv.classList.remove('prev-exit'); currentWordDiv.classList.remove('current-enter'); nextWordDiv.classList.remove('next-enter');
            prevWordDiv.style.opacity = prevText ? '0.45' : '0'; currentWordDiv.style.opacity = '1'; nextWordDiv.style.opacity = nextText ? '0.45' : '0';
        }, 500);
    }

    audio.addEventListener('timeupdate', () => {
        if (audio.duration) {
            currentTimeSpan.textContent = formatTime(audio.currentTime);
            durationSpan.textContent = formatTime(audio.duration);
        }
        updateLyricsByTime(audio.currentTime);
    });

    function enableSlow3D(enable) { if (enable) lyricsWordDiv.classList.add('rotate-3d-active'); else lyricsWordDiv.classList.remove('rotate-3d-active'); }

    function switchUIMode() {
        if (currentMode === 'stage') {
            lyricsWordDiv.style.visibility = 'hidden'; lyricsWordDiv.style.position = 'absolute';
            stageContainer.style.visibility = 'visible'; stageContainer.style.position = 'relative';
            [prevWordDiv, currentWordDiv, nextWordDiv].forEach(el => el.classList.remove('prev-exit', 'current-enter', 'next-enter'));
        } else {
            lyricsWordDiv.style.visibility = 'visible'; lyricsWordDiv.style.position = 'relative';
            stageContainer.style.visibility = 'hidden'; stageContainer.style.position = 'absolute';
        }
    }

    function toggleMode() {
        if (currentMode === 'word') { currentMode = 'sentence'; toggleModeBtn.innerHTML = '🔁 وضع: جملة'; }
        else if (currentMode === 'sentence') { currentMode = 'stage'; toggleModeBtn.innerHTML = '🔁 وضع: مسرح'; }
        else { currentMode = 'word'; toggleModeBtn.innerHTML = '🔁 وضع: كلمة'; }
        lastStageIndex = -1;
        switchUIMode();
        enableSlow3D(isPlaying);
        if (audio && !isNaN(audio.currentTime)) updateLyricsByTime(audio.currentTime);
    }

    function clearSRT() {
        const songId = getCurrentSongId();
        if (songId) songLyricsMap.delete(songId);
        srtCues = []; wordTimeline = []; rawLyricsContent = null; rawLyricsFileName = null; srtInput.value = '';
        srtStatusMsg.innerHTML = 'تم مسح الترجمة - ارفع SRT أو LRC جديد';
        if (currentMode === 'stage') { prevWordDiv.textContent = ''; currentWordDiv.textContent = '📄 تم المسح'; nextWordDiv.textContent = ''; }
        else lyricsWordDiv.innerText = '📄 تم المسح';
        lastStageIndex = -1;
    }

    function processLyricsFile(content, fileName) {
        const songId = getCurrentSongId();
        let songDur = audio.duration && !isNaN(audio.duration) ? audio.duration : 300;
        const result = loadLyricsData(content, fileName, songDur);
        if (result && songId) {
            songLyricsMap.set(songId, { cues: result.cues, words: result.words, content, fileName });
            srtCues = result.cues; wordTimeline = result.words; rawLyricsContent = content; rawLyricsFileName = fileName;
            srtStatusMsg.innerHTML = `✅ تم تحميل وحفظ ${result.cues.length} مقطع (${result.words.length} كلمة) - ${fileName}`;
            lastStageIndex = -1;
            if (audio && !isNaN(audio.currentTime)) updateLyricsByTime(audio.currentTime);
        } else {
            srtStatusMsg.innerHTML = "❌ خطأ في تنسيق الملف";
            if (!songId) srtStatusMsg.innerHTML += " | أضف أغنية أولاً";
        }
    }

    srtInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => processLyricsFile(ev.target.result, file.name);
        reader.readAsText(file, "UTF-8");
        e.target.value = '';
    });
    clearSrtBtn.addEventListener('click', clearSRT);
    toggleModeBtn.addEventListener('click', toggleMode);

    function getCurrentSongId() { return songs[currentIndex]?.src || null; }

    function loadLyricsForCurrentSong() {
        const songId = getCurrentSongId();
        if (songId && songLyricsMap.has(songId)) {
            const data = songLyricsMap.get(songId);
            srtCues = data.cues; wordTimeline = data.words; rawLyricsContent = data.content; rawLyricsFileName = data.fileName;
            srtStatusMsg.innerHTML = `✅ ترجمة محفوظة: ${data.cues.length} مقطع (${data.words.length} كلمة) - ${data.fileName}`;
        } else {
            srtCues = []; wordTimeline = []; rawLyricsContent = null; rawLyricsFileName = null;
            srtStatusMsg.innerHTML = "🎤 لا توجد ترجمة لهذه الأغنية.";
        }
        lastStageIndex = -1;
        updateLyricsByTime(audio.currentTime || 0);
        switchUIMode();
    }

    // ========== الحصول على مدة الملف الصوتي ==========
    function getAudioDuration(file) {
        return new Promise((resolve) => {
            const tempAudio = new Audio();
            const url = URL.createObjectURL(file);
            tempAudio.src = url;
            tempAudio.addEventListener('loadedmetadata', () => { const dur = tempAudio.duration; URL.revokeObjectURL(url); resolve(isNaN(dur) ? 0 : dur); });
            tempAudio.addEventListener('error', () => { URL.revokeObjectURL(url); resolve(0); });
        });
    }

    // ========== إدارة الأغاني وقائمة التشغيل ==========
    function updatePlaylistCount() { playlistCountSpan.textContent = songs.length; }

    function renderPlaylistItem(index) {
        const song = songs[index];
        const item = document.createElement('div');
        item.className = 'playlist-item';
        item.draggable = true;
        item.dataset.index = index;
        const durText = song.duration > 0 ? formatTime(song.duration) : '--:--';
        item.innerHTML = `
            <span class="drag-handle" title="اسحب لإعادة الترتيب">⋮⋮</span>
            <span class="song-index">${index + 1}</span>
            <span class="song-name" title="${song.title}">${song.title}</span>
            <span class="song-duration">${durText}</span>
            <button class="delete-song-btn" title="حذف الأغنية" data-index="${index}">×</button>
        `;
        if (index === currentIndex) item.classList.add('active');
        item.addEventListener('click', (e) => {
            if (e.target.closest('.delete-song-btn') || e.target.closest('.drag-handle')) return;
            currentIndex = index;
            loadSong(currentIndex);
            if (isPlaying) audio.play();
            updatePlaylistActive();
        });
        item.querySelector('.delete-song-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteSong(index); });
        item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', index.toString()); e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); });
        item.addEventListener('dragend', () => { item.classList.remove('dragging'); });
        item.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; item.classList.add('drag-over'); });
        item.addEventListener('dragleave', () => { item.classList.remove('drag-over'); });
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const toIndex = parseInt(item.dataset.index, 10);
            if (fromIndex !== toIndex && !isNaN(fromIndex) && !isNaN(toIndex)) { moveSong(fromIndex, toIndex); }
        });
        let touchDragStartY = 0;
        item.querySelector('.drag-handle').addEventListener('touchstart', (e) => { touchDragStartY = e.touches[0].clientY; item.style.transition = 'none'; });
        item.querySelector('.drag-handle').addEventListener('touchmove', (e) => {
            const diffY = e.touches[0].clientY - touchDragStartY;
            item.style.transform = `translateY(${diffY}px)`; item.style.zIndex = '10'; item.style.opacity = '0.8';
            const allItems = [...playlistDiv.querySelectorAll('.playlist-item')];
            allItems.forEach(it => it.classList.remove('drag-over'));
            const targetItem = allItems.find(it => { const rect = it.getBoundingClientRect(); return e.touches[0].clientY >= rect.top && e.touches[0].clientY <= rect.bottom && it !== item; });
            if (targetItem) targetItem.classList.add('drag-over');
        });
        item.querySelector('.drag-handle').addEventListener('touchend', (e) => {
            item.style.transition = 'all 0.2s'; item.style.transform = ''; item.style.zIndex = ''; item.style.opacity = '';
            const allItems = [...playlistDiv.querySelectorAll('.playlist-item')];
            allItems.forEach(it => it.classList.remove('drag-over'));
            const targetItem = allItems.find(it => { const rect = it.getBoundingClientRect(); return e.changedTouches[0].clientY >= rect.top && e.changedTouches[0].clientY <= rect.bottom && it !== item; });
            if (targetItem) { const fromIdx = parseInt(item.dataset.index, 10); const toIdx = parseInt(targetItem.dataset.index, 10); if (!isNaN(fromIdx) && !isNaN(toIdx) && fromIdx !== toIdx) moveSong(fromIdx, toIdx); }
        });
        return item;
    }

    function refreshPlaylist() {
        playlistDiv.innerHTML = '';
        if (songs.length === 0) {
            playlistDiv.innerHTML = '<div class="playlist-empty">🎵 لا توجد أغانٍ - أضف ملفات موسيقية</div>';
        } else {
            songs.forEach((_, i) => { playlistDiv.appendChild(renderPlaylistItem(i)); });
        }
        updatePlaylistCount();
    }

    function updatePlaylistActive() {
        document.querySelectorAll('.playlist-item').forEach((item, i) => { if (i === currentIndex) item.classList.add('active'); else item.classList.remove('active'); });
    }

    function deleteSong(index) {
        if (index < 0 || index >= songs.length) return;
        const song = songs[index];
        if (song.src && allObjectURLs.includes(song.src)) {
            const currentSrc = songs[currentIndex]?.src;
            if (song.src !== currentSrc) { URL.revokeObjectURL(song.src); allObjectURLs = allObjectURLs.filter(u => u !== song.src); }
        }
        const songId = song.src;
        if (songId) songLyricsMap.delete(songId);
        songs.splice(index, 1);
        if (songs.length === 0) {
            currentIndex = 0;
            audio.src = '';
            songTitleSpan.textContent = '🎵 أضف موسيقى'; songArtistSpan.textContent = 'فنان فضي';
            albumImage.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%232A2A38'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='20' fill='%23E8E8F2'%3Eغلاف%3C/text%3E%3C/svg%3E";
            waveformData = null; drawWaveform(0, 1); srtCues = []; wordTimeline = [];
            updateMediaSession();
        } else {
            if (currentIndex >= songs.length) currentIndex = songs.length - 1;
            if (index <= currentIndex && currentIndex > 0) currentIndex--;
            loadSong(currentIndex); if (isPlaying) audio.play();
        }
        refreshPlaylist(); updatePlaylistActive(); showToast('🗑 تم حذف الأغنية');
    }

    function moveSong(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        const song = songs.splice(fromIndex, 1)[0];
        songs.splice(toIndex, 0, song);
        if (currentIndex === fromIndex) currentIndex = toIndex;
        else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
        else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;
        refreshPlaylist(); updatePlaylistActive();
    }

    function clearAllPlaylist() {
        if (songs.length === 0) return;
        if (!confirm('هل أنت متأكد من مسح قائمة التشغيل بالكامل؟')) return;
        const currentSrc = songs[currentIndex]?.src;
        for (let song of songs) { if (song.src && song.src !== currentSrc && allObjectURLs.includes(song.src)) { URL.revokeObjectURL(song.src); } }
        allObjectURLs = allObjectURLs.filter(u => u === currentSrc);
        songLyricsMap.clear();
        songs = []; currentIndex = 0;
        userPaused = true;           // ✅ منع الاستئناف التلقائي بعد المسح
        stopAutoResume();            // ✅ إيقاف أي محاولة استئناف
        audio.pause();
        isPlaying = false; playPauseBtn.innerHTML = '▶️';
        stopAlbumRotation(); enableSlow3D(false); stopVisualizerLoop(); stopSpectrumLoop(); stopWaveformProgress();
        songTitleSpan.textContent = '🎵 أضف موسيقى'; songArtistSpan.textContent = 'فنان فضي';
        waveformData = null; srtCues = []; wordTimeline = [];
        updateMediaSession(); refreshPlaylist(); updatePlaylistActive(); showToast('🗑 تم مسح قائمة التشغيل');
    }

    function exportPlaylist() {
        if (songs.length === 0) { showToast('⚠️ لا توجد أغانٍ للتصدير'); return; }
        const data = songs.map((s, i) => ({ index: i, title: s.title, artist: s.artist, duration: s.duration, fileName: s.title }));
        const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), songs: data }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'playlist-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
        URL.revokeObjectURL(url); showToast('💾 تم تصدير قائمة التشغيل');
    }

    function importPlaylist(file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (!data.songs || !Array.isArray(data.songs)) throw new Error('تنسيق غير صالح');
                showToast(`📥 تم استيراد ${data.songs.length} أغنية (المسارات المرجعية فقط - أعد إضافة الملفات الصوتية)`);
                alert('تم استيراد بيانات قائمة التشغيل. ملاحظة: لا يمكن استعادة الملفات الصوتية الفعلية، يجب إعادة إضافتها يدوياً.');
            } catch (e) { showToast('❌ فشل استيراد الملف: تنسيق غير صالح'); }
        };
        reader.readAsText(file, 'UTF-8');
    }

    async function addSongs(files) {
        for (let file of files) {
            let url = URL.createObjectURL(file);
            allObjectURLs.push(url);
            const duration = await getAudioDuration(file);
            songs.push({ title: file.name.replace(/\.[^/.]+$/, ''), artist: "فنان فضي", src: url, cover: "", duration: duration });
        }
        refreshPlaylist();
        if (songs.length > 0 && !audio.src) { currentIndex = 0; loadSong(0); if (!isAudioInitialized) initAudioContext(); updatePlaylistActive(); }
        updatePlaylistCount();
    }

    function stopAlbumRotation() { albumContainer.classList.remove('rotating'); }
    function startAlbumRotation() { if (isPlaying) albumContainer.classList.add('rotating'); }
    function showLoading() { loadingOverlay.style.display = 'flex'; }
    function hideLoading() { loadingOverlay.style.display = 'none'; }

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
        audio.oncanplay = () => { hideLoading(); };
        audio.onerror = () => { hideLoading(); srtStatusMsg.innerHTML = "⚠️ خطأ في تحميل الملف الصوتي"; };
        if (isPlaying) { audio.play().catch(e => console.log); enableSlow3D(true); } else enableSlow3D(false);
        updateLyricsByTime(0);
        setTimeout(() => { if (waveformData) drawWaveform(0, audio.duration || 1); }, 300);
        updatePlaylistActive();
        if (songs[index].duration <= 0 && audio.duration && !isNaN(audio.duration)) { songs[index].duration = audio.duration; refreshPlaylist(); updatePlaylistActive(); }
    }

    function playNext() {
        if (!songs.length) return;
        if (isShuffling) {
            let newIdx;
            do { newIdx = Math.floor(Math.random() * songs.length); } while (newIdx === currentIndex && songs.length > 1);
            currentIndex = newIdx;
        } else {
            currentIndex++;
            if (currentIndex >= songs.length) currentIndex = 0;
        }
        loadSong(currentIndex);
        if (isPlaying) audio.play();
        updatePlaylistActive();
    }

    // ========== معالجة الصوت ==========
    function applyBoostSettings() {
        if (!gainNode) return;
        gainNode.gain.value = volumeEnhance * boostLevel;
        if (filters.length > 0 && filters[0].type === 'lowshelf') { filters[0].gain.value = bassLevelVal; document.getElementById('bassValue').innerText = Math.round((bassLevelVal / 24) * 100) + '%'; }
        saveSettings();
    }

    function createReverbBuffer(ctx, duration = 2.8, decay = 3.5) {
        const sampleRate = ctx.sampleRate;
        const length = sampleRate * duration;
        const impulse = ctx.createBuffer(2, length, sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                const t = i / sampleRate;
                let envelope = Math.exp(-t * decay);
                let random = (Math.random() * 2 - 1) * 0.6 * envelope;
                let value = (i === 0) ? 1.0 : random;
                if (channel === 1 && i > sampleRate * 0.07) value += data[i - Math.floor(sampleRate * 0.07)] * 0.35;
                data[i] = Math.max(-1, Math.min(1, value * envelope)) * 0.9;
            }
        }
        return impulse;
    }

    async function initAudioContext() {
        if (isAudioInitialized) return;
        try {
            audioContext = new(window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
            if (audioContext.state === 'suspended') await audioContext.resume();
            source = audioContext.createMediaElementSource(audio);
            gainNode = audioContext.createGain();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.7;
            const eqFreqs = [80, 32, 50, 80, 125, 200, 315, 500, 800, 1200, 2000, 3150, 5000, 8000, 12500, 16000, 18000, 20000];
            filters = [];
            for (let i = 0; i < eqFreqs.length; i++) {
                let f = audioContext.createBiquadFilter();
                if (i === 0) { f.type = 'lowshelf'; f.frequency.value = 80; }
                else if (i === eqFreqs.length - 1) f.type = 'highshelf';
                else f.type = 'peaking';
                f.frequency.value = eqFreqs[i];
                f.Q.value = 0.7;
                f.gain.value = 0;
                filters.push(f);
            }
            source.connect(gainNode);
            let prev = gainNode;
            for (let f of filters) { prev.connect(f); prev = f; }
            const afterEq = prev;
            convolverNode = audioContext.createConvolver();
            convolverNode.buffer = createReverbBuffer(audioContext, 2.8, 3.5);
            wetGain = audioContext.createGain();
            dryGain = audioContext.createGain();
            mixGain = audioContext.createGain();
            wetGain.gain.value = reverbSliderValue * 1.2;
            dryGain.gain.value = 0.8;
            afterEq.connect(dryGain); dryGain.connect(mixGain);
            afterEq.connect(convolverNode); convolverNode.connect(wetGain); wetGain.connect(mixGain);
            mixGain.connect(analyser); analyser.connect(audioContext.destination);
            isAudioInitialized = true;
            applyBoostSettings();
            loadSettings();
            startSpectrumLoop();
            startVisualizerLoop();
        } catch (err) { console.error("فشل تهيئة الصوت:", err); }
    }

    function startSpectrumLoop() {
        if (spectrumAnimId) return;
        let dataArray = new Uint8Array(analyser.frequencyBinCount);
        function draw() {
            if (!analyser || !spectrumCanvas) return;
            analyser.getByteFrequencyData(dataArray);
            const width = spectrumCanvas.clientWidth;
            const height = spectrumCanvas.clientHeight;
            spectrumCanvas.width = width;
            spectrumCanvas.height = height;
            ctx.clearRect(0, 0, width, height);
            let barCount = 80;
            for (let i = 0; i < barCount; i++) {
                let minFreq = 20, maxFreq = 20000;
                let freq = minFreq * Math.pow(maxFreq / minFreq, i / (barCount - 1));
                let idx = Math.floor((freq / (audioContext.sampleRate / 2)) * analyser.frequencyBinCount);
                idx = Math.min(analyser.frequencyBinCount - 1, Math.max(0, idx));
                let val = dataArray[idx] / 255;
                let h = val * height;
                let gray = 100 + val * 155;
                ctx.fillStyle = `rgb(${gray}, ${gray-40}, 240)`;
                ctx.fillRect(i * (width / barCount), height - h, (width / barCount) - 1.5, h);
            }
            spectrumAnimId = requestAnimationFrame(draw);
        }
        draw();
    }

    function stopSpectrumLoop() { if (spectrumAnimId) { cancelAnimationFrame(spectrumAnimId); spectrumAnimId = null; } }

    function startVisualizerLoop() {
        if (visualizerAnimId) return;
        let freqData = new Uint8Array(analyser.frequencyBinCount);
        function updateViz() {
            if (!analyser || !isPlaying) { visualizerAnimId = null; return; }
            analyser.getByteFrequencyData(freqData);
            for (let i = 0; i < visualizerBars.length; i++) {
                let idx = Math.floor((i / visualizerBars.length) * analyser.frequencyBinCount);
                let h = (freqData[idx] / 255) * 45 + 5;
                visualizerBars[i].style.height = h + 'px';
                let intensity = h / 50;
                visualizerBars[i].style.background = `linear-gradient(to top, #8A8AA8, rgb(${180+intensity*75}, ${180+intensity*75}, 255))`;
            }
            visualizerAnimId = requestAnimationFrame(updateViz);
        }
        visualizerAnimId = requestAnimationFrame(updateViz);
    }

    function stopVisualizerLoop() { if (visualizerAnimId) { cancelAnimationFrame(visualizerAnimId); visualizerAnimId = null; } }

    // ========== أحداث الأزرار ==========
    playPauseBtn.onclick = async () => {
        if (!songs.length) { alert("أضف أغاني أولا"); return; }
        if (!isAudioInitialized) await initAudioContext();
        if (isPlaying) {
            userPaused = true;   // ✅ المستخدم أوقف التشغيل يدويًا
            stopAutoResume();    // ✅ إيقاف أي محاولة استئناف جارية
            audio.pause();
            playPauseBtn.innerHTML = '▶️';
            stopAlbumRotation();
            enableSlow3D(false);
            stopVisualizerLoop();
            stopSpectrumLoop();
            stopWaveformProgress();
        } else {
            userPaused = false;  // ✅ المستخدم يطلب التشغيل
            if (audioContext && audioContext.state === 'suspended') await audioContext.resume();
            audio.play();
            playPauseBtn.innerHTML = '⏸️';
            startAlbumRotation();
            enableSlow3D(true);
            startVisualizerLoop();
            startSpectrumLoop();
            startWaveformProgress();
        }
        isPlaying = !isPlaying;
        updateMediaSession();
    };

    audio.addEventListener('ended', () => { if (isRepeating) { audio.currentTime = 0; audio.play(); } else playNext(); });

    // ✅ مستمع التوقف - يكتشف التوقف الخارجي (إعلانات، مكالمات، إلخ)
    audio.addEventListener('pause', () => {
        if (!userPaused && autoResumeEnabled && isPlaying && songs.length) {
            console.log("🔍 تم اكتشاف توقف خارجي (قد يكون إعلاناً)، بدء محاولة الاستئناف...");
            startAutoResume();
        }
    });

    // ✅ مستمع التشغيل - يعيد تعيين علامة التوقف اليدوي
    audio.addEventListener('play', () => {
        userPaused = false;
        stopAutoResume();
    });

    volumeSlider.addEventListener('click', (e) => {
        let vol = Math.min(1, Math.max(0, e.offsetX / volumeSlider.clientWidth));
        audio.volume = vol; volumeProgress.style.width = vol * 100 + '%'; volumeEnhance = vol; applyBoostSettings();
    });
    repeatBtn.onclick = () => { isRepeating = !isRepeating; repeatBtn.classList.toggle('active', isRepeating); };
    shuffleBtn.onclick = () => { isShuffling = !isShuffling; shuffleBtn.classList.toggle('active', isShuffling); };
    nextBtn.onclick = () => { playNext(); if (isPlaying) audio.play(); };
    prevBtn.onclick = () => { if (songs.length) { currentIndex--; if (currentIndex < 0) currentIndex = songs.length - 1; loadSong(currentIndex); if (isPlaying) audio.play(); updatePlaylistActive(); } };

    // Boost
    let boostActive = false;
    const boostChip = document.getElementById('boostChip');
    boostChip.onclick = () => {
        if (!boostActive) { boostLevel = 1.8; boostActive = true; boostChip.classList.add('active-chip'); }
        else { boostLevel = 1.0; boostActive = false; boostChip.classList.remove('active-chip'); }
        applyBoostSettings();
        const bs = document.getElementById('boostEnhancementSlider'); if (bs) bs.value = (boostLevel - 1) * 50;
        document.getElementById('boostIndicator').innerText = `x${boostLevel.toFixed(1)}`;
    };

    // Power Save
    let powerSave = false;
    const powerSaveChip = document.getElementById('powerSaveChip');
    powerSaveChip.onclick = () => {
        powerSave = !powerSave;
        document.body.classList.toggle('power-save-mode', powerSave);
        if (powerSave) powerSaveChip.classList.add('active-chip'); else powerSaveChip.classList.remove('active-chip');
        if (powerSave && isCameraRotating) cameraToggleChip.click();
        if (powerSave) stopAlbumRotation();
        if (powerSave) { stopVisualizerLoop(); stopSpectrumLoop(); } else if (isPlaying) { startVisualizerLoop(); startSpectrumLoop(); }
    };

    // Camera
    const cameraToggleChip = document.getElementById('cameraToggleChip');
    cameraToggleChip.onclick = () => {
        if (powerSave) { showToast("وضع توفير الطاقة مفعّل"); return; }
        isCameraRotating = !isCameraRotating;
        if (isCameraRotating) {
            cameraToggleChip.classList.add('active-chip'); cameraToggleChip.textContent = '⏹️';
            function rotate() { if (!isCameraRotating) return; rotationAngle += 0.6; playerSection.style.transform = `rotateY(${rotationAngle}deg) rotateX(4deg)`; cameraId = requestAnimationFrame(rotate); }
            rotate();
        } else { cancelAnimationFrame(cameraId); playerSection.style.transform = 'none'; cameraToggleChip.classList.remove('active-chip'); cameraToggleChip.textContent = '🎥'; }
    };

    // Palace
    const palaceToggleChip = document.getElementById('palaceToggleChip');
    palaceToggleChip.onclick = () => { palaceEnabled = !palaceEnabled; palaceControls.style.display = palaceEnabled ? 'block' : 'none'; if (palaceEnabled) palaceToggleChip.classList.add('palace-active'); else palaceToggleChip.classList.remove('palace-active'); };

    // Advanced toggle
    advancedToggleChip.onclick = () => { advancedPanelVisible = !advancedPanelVisible; if (advancedPanelVisible) { advancedSection.classList.remove('hidden-panel'); advancedToggleChip.classList.add('active-chip'); } else { advancedSection.classList.add('hidden-panel'); advancedToggleChip.classList.remove('active-chip'); } };

    // Info modal
    const infoChip = document.getElementById('infoChip'), infoModal = document.getElementById('infoModal'), closeInfoModalBtn = document.getElementById('closeInfoModal');
    infoChip.onclick = () => infoModal.classList.add('open');
    closeInfoModalBtn.onclick = () => infoModal.classList.remove('open');
    infoModal.addEventListener('click', (e) => { if (e.target === infoModal) infoModal.classList.remove('open'); });

    // Shortcuts modal
    const shortcutsFab = document.getElementById('shortcutsFab'), shortcutsModal = document.getElementById('shortcutsModal'), closeShortcutsModalBtn = document.getElementById('closeShortcutsModal');
    shortcutsFab.onclick = () => shortcutsModal.classList.add('open');
    closeShortcutsModalBtn.onclick = () => shortcutsModal.classList.remove('open');
    shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) shortcutsModal.classList.remove('open'); });

    // Fullscreen
    document.getElementById('fullscreenFab').onclick = () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); };

    // Burger menu
    burgerMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); burgerDropdown.classList.toggle('open'); burgerMenuBtn.classList.toggle('active'); });
    document.addEventListener('click', (e) => { if (!burgerDropdown.contains(e.target) && e.target !== burgerMenuBtn) { burgerDropdown.classList.remove('open'); burgerMenuBtn.classList.remove('active'); } });
    burgerDropdown.querySelectorAll('.dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action; burgerDropdown.classList.remove('open'); burgerMenuBtn.classList.remove('active');
            switch (action) {
                case 'camera': cameraToggleChip.click(); break;
                case 'palace': palaceToggleChip.click(); break;
                case 'boost': boostChip.click(); break;
                case 'powersave': powerSaveChip.click(); break;
                case 'advanced': advancedToggleChip.click(); break;
                case 'info': infoChip.click(); break;
                case 'shortcuts': shortcutsFab.click(); break;
            }
        });
    });

    // قائمة التشغيل: أزرار الإدارة
    document.getElementById('exportPlaylistBtn').addEventListener('click', exportPlaylist);
    document.getElementById('importPlaylistBtn').addEventListener('click', () => { document.getElementById('importPlaylistInput').click(); });
    document.getElementById('importPlaylistInput').addEventListener('change', (e) => { if (e.target.files[0]) { importPlaylist(e.target.files[0]); e.target.value = ''; } });
    document.getElementById('clearPlaylistBtn').addEventListener('click', clearAllPlaylist);

    // رفع الملفات
    fileInput.addEventListener('change', (e) => { addSongs(Array.from(e.target.files)); fileInput.value = ''; });
    document.getElementById('imageInput').addEventListener('change', (e) => { if (e.target.files[0]) { let reader = new FileReader(); reader.onload = ev => { albumImage.src = ev.target.result; if (songs[currentIndex]) songs[currentIndex].cover = ev.target.result; updateMediaSession(); }; reader.readAsDataURL(e.target.files[0]); } });

    // Palace controls
    document.getElementById('applyPalaceEffect').addEventListener('click', () => {
        let val = parseFloat(document.getElementById('palaceSize').value) / 100;
        if (wetGain && dryGain) { wetGain.gain.value = Math.min(1.3, reverbSliderValue + val * 0.9); dryGain.gain.value = Math.max(0.4, 0.8 - val * 0.25); document.getElementById('palaceStatus').innerHTML = `🏰 قصر نشط: صدى ${Math.round(wetGain.gain.value*100)}%`; }
    });
    document.getElementById('resetPalaceEffect').addEventListener('click', () => { if (wetGain && dryGain) { wetGain.gain.value = reverbSliderValue * 1.2; dryGain.gain.value = 0.8; document.getElementById('palaceStatus').innerHTML = "تم إعادة التعيين"; } });
    document.getElementById('palaceSize').addEventListener('input', (e) => { document.getElementById('palaceSizeValue').innerText = e.target.value + '%'; });

    // EQ
    const eqContainer = document.getElementById('eqBands');
    const eqPresets = { flat: Array(18).fill(0), bass: [6,5,4,3,2,1,0,-1,-1,0,1,1,0,0,0,0,0,0], vocal: [-2,-1,0,1,2,3,3,2,1,0,0,-1,-2,-2,-2,-1,-1,0], rock: [4,4,3,2,1,0,1,2,3,3,3,2,1,0,0,0,0,0], electronic: [5,5,3,1,0,-1,0,1,2,3,3,2,1,1,0,0,0,0] };
    function buildEQ() {
        eqContainer.innerHTML = '';
        const freqs = ['80','32','50','80','125','200','315','500','800','1.2k','2k','3.15k','5k','8k','12.5k','16k','18k','20k'];
        freqs.forEach((f, i) => {
            let div = document.createElement('div'); div.style.textAlign = 'center';
            div.innerHTML = `<input type="range" class="eq-slider" min="-12" max="12" value="0" data-index="${i}"><div style="font-size:10px;">${f}</div><div style="font-size:10px;" id="eqVal${i}">0dB</div>`;
            eqContainer.appendChild(div);
            let slider = div.querySelector('input');
            slider.oninput = () => { let val = parseFloat(slider.value); document.getElementById(`eqVal${i}`).innerText = val + 'dB'; if (filters[i]) filters[i].gain.value = val; saveSettings(); };
        });
    }
    buildEQ();
    document.querySelectorAll('.preset-btn').forEach(btn => { btn.onclick = () => { let preset = btn.dataset.preset; if (eqPresets[preset]) eqPresets[preset].forEach((val, idx) => { let slider = document.querySelector(`.eq-slider[data-index="${idx}"]`); if (slider) { slider.value = val; slider.dispatchEvent(new Event('input')); } }); saveSettings(); }; });

    document.getElementById('reverb').oninput = (e) => { reverbSliderValue = parseFloat(e.target.value)/100; document.getElementById('reverbValue').innerText = e.target.value + '%'; if (wetGain) wetGain.gain.value = reverbSliderValue * 1.2; saveSettings(); };
    document.getElementById('playbackSpeed').oninput = (e) => { audio.playbackRate = e.target.value/100; document.getElementById('speedValue').innerText = e.target.value + '%'; };
    document.getElementById('volumeEnhancementSlider').oninput = (e) => { volumeEnhance = e.target.value/100; document.getElementById('volumeValue').innerText = e.target.value + '%'; applyBoostSettings(); };
    document.getElementById('boostEnhancementSlider').oninput = (e) => { boostLevel = 1 + (e.target.value/100)*2; document.getElementById('boostIndicator').innerText = `x${boostLevel.toFixed(1)}`; applyBoostSettings(); boostActive = (boostLevel > 1.1); if (boostActive) boostChip.classList.add('active-chip'); else boostChip.classList.remove('active-chip'); };
    document.getElementById('bassEnhancementSlider').oninput = (e) => { bassLevelVal = (e.target.value/100)*24; document.getElementById('bassValue').innerText = e.target.value + '%'; applyBoostSettings(); };

    // اختصارات لوحة المفاتيح
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        switch (e.key) {
            case ' ': e.preventDefault(); playPauseBtn.click(); break;
            case 'ArrowRight': nextBtn.click(); break;
            case 'ArrowLeft': prevBtn.click(); break;
            case 'ArrowUp': audio.volume = Math.min(1, audio.volume + 0.05); volumeProgress.style.width = audio.volume*100+'%'; volumeEnhance = audio.volume; applyBoostSettings(); break;
            case 'ArrowDown': audio.volume = Math.max(0, audio.volume - 0.05); volumeProgress.style.width = audio.volume*100+'%'; volumeEnhance = audio.volume; applyBoostSettings(); break;
            case 'r': repeatBtn.click(); break;
            case 's': shuffleBtn.click(); break;
            case 'b': boostChip.click(); break;
            case 'c': cameraToggleChip.click(); break;
            case 'p': powerSaveChip.click(); break;
            case 't': palaceToggleChip.click(); break;
            case 'h': advancedToggleChip.click(); break;
        }
    });

    // حفظ/تحميل الإعدادات
    function saveSettings() {
        const settings = { volumeEnhance, boostLevel, bassLevelVal, reverbSliderValue, eqValues: filters.map(f => f.gain.value), volume: audio.volume };
        localStorage.setItem('silverPlayerSettings_v2', JSON.stringify(settings));
    }
    function loadSettings() {
        const saved = localStorage.getItem('silverPlayerSettings_v2');
        if (!saved) return;
        try {
            const s = JSON.parse(saved);
            volumeEnhance = s.volumeEnhance || 0.7; boostLevel = s.boostLevel || 1.0; bassLevelVal = s.bassLevelVal || 0; reverbSliderValue = s.reverbSliderValue || 0.3;
            audio.volume = s.volume || 0.7; volumeProgress.style.width = (audio.volume*100)+'%';
            document.getElementById('volumeEnhancementSlider').value = volumeEnhance*100; document.getElementById('volumeValue').innerText = Math.round(volumeEnhance*100)+'%';
            document.getElementById('boostEnhancementSlider').value = (boostLevel-1)*50; document.getElementById('boostIndicator').innerText = `x${boostLevel.toFixed(1)}`;
            document.getElementById('bassEnhancementSlider').value = (bassLevelVal/24)*100; document.getElementById('bassValue').innerText = Math.round((bassLevelVal/24)*100)+'%';
            document.getElementById('reverb').value = reverbSliderValue*100; document.getElementById('reverbValue').innerText = Math.round(reverbSliderValue*100)+'%';
            if (wetGain) wetGain.gain.value = reverbSliderValue*1.2;
            if (s.eqValues && filters.length === s.eqValues.length) {
                filters.forEach((f, i) => { f.gain.value = s.eqValues[i]; const slider = document.querySelector(`.eq-slider[data-index="${i}"]`); if (slider) { slider.value = s.eqValues[i]; document.getElementById(`eqVal${i}`).innerText = s.eqValues[i]+'dB'; } });
            }
            applyBoostSettings();
        } catch (e) { console.warn("إعدادات غير صالحة"); }
    }

    // السحب والإفلات العام
    function handleDragEnter(e) { document.body.classList.add('drag-over'); dropOverlay.classList.add('show'); }
    function handleDragLeave(e) { if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return; document.body.classList.remove('drag-over'); dropOverlay.classList.remove('show'); }
    function handleDragOver(e) { e.preventDefault(); e.stopPropagation(); }
    function handleDrop(e) {
        e.preventDefault(); e.stopPropagation();
        document.body.classList.remove('drag-over'); dropOverlay.classList.remove('show');
        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        const audioFiles = []; let lyricsFile = null;
        const audioExtensions = ['mp3','wav','ogg','aac','flac','m4a','opus'];
        const lyricsExtensions = ['srt','lrc','txt'];
        for (let file of files) {
            const ext = file.name.toLowerCase().split('.').pop();
            if (audioExtensions.includes(ext)) audioFiles.push(file);
            else if (lyricsExtensions.includes(ext) && !lyricsFile) lyricsFile = file;
        }
        if (audioFiles.length > 0) addSongs(audioFiles);
        if (lyricsFile) { const reader = new FileReader(); reader.onload = (ev) => processLyricsFile(ev.target.result, lyricsFile.name); reader.readAsText(lyricsFile, "UTF-8"); }
    }
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    // تهيئة
    function createStars() {
        let starsDiv = document.getElementById('starsBackground');
        for (let i = 0; i < 120; i++) {
            let s = document.createElement('div'); s.classList.add('star');
            s.style.width = Math.random()*3+1+'px'; s.style.height = s.style.width;
            s.style.left = Math.random()*100+'%'; s.style.top = Math.random()*100+'%';
            s.style.animationDelay = Math.random()*4+'s'; starsDiv.appendChild(s);
        }
    }
    createStars();
    switchUIMode();
    enableSlow3D(false);
    for (let i = 0; i < 20; i++) { let bar = document.createElement('div'); bar.classList.add('bar'); visualizerDiv.appendChild(bar); }
    visualizerBars = document.querySelectorAll('.bar');
    refreshPlaylist(); updatePlaylistCount(); loadSettings();

    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => { if (!isPlaying) playPauseBtn.click(); });
        navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) playPauseBtn.click(); });
        navigator.mediaSession.setActionHandler('previoustrack', () => prevBtn.click());
        navigator.mediaSession.setActionHandler('nexttrack', () => nextBtn.click());
    }
})();
