const fs = require('fs');
let code = fs.readFileSync('d:/구글안티그래비티/callphobia-app/src/VoiceCallTrainer.js', 'utf8');

const replacement = `
  // ── WebAudio & WebSocket (Realtime API) ──
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletNodeRef = useRef(null);
  const streamRef = useRef(null);
  const nextPlayTimeRef = useRef(0);

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  const playAudioChunk = (base64Str) => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    try {
      const binaryStr = atob(base64Str);
      const len = binaryStr.length;
      const pcm16 = new Int16Array(len / 2);
      for (let i = 0; i < len / 2; i++) {
        const low = binaryStr.charCodeAt(i * 2);
        const high = binaryStr.charCodeAt(i * 2 + 1);
        let value = (high << 8) | low;
        if (value >= 0x8000) value -= 0x10000;
        pcm16[i] = value;
      }
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      
      const currentTime = ctx.currentTime;
      const playTime = Math.max(currentTime + 0.05, nextPlayTimeRef.current);
      source.start(playTime);
      nextPlayTimeRef.current = playTime + audioBuffer.duration;
    } catch(e) { console.error('Audio chunk error:', e); }
  };

  const startCall = async (lv) => {
    isEndingRef.current = false;
    setLevel(lv);
    setIsConnecting(true);
    setMessages([]);
    setCallDuration(0);
    setVoiceState('processing'); // 로딩중
    setTranscript('');

    const isLocalhostDev = window.location.hostname === 'localhost' && window.location.port !== '3001';
    const wsUrl = isLocalhostDev 
      ? 'ws://localhost:3001' 
      : \`\${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//\${window.location.host}\`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = async () => {
      // Setup audio capture
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
        streamRef.current = stream;

        const audioCtx = new window.AudioContext({ sampleRate: 24000 });
        audioCtxRef.current = audioCtx;
        nextPlayTimeRef.current = audioCtx.currentTime;

        await audioCtx.audioWorklet.addModule('/audio-processor.js');

        const source = audioCtx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(audioCtx, 'audio-processor');
        workletNodeRef.current = workletNode;

        workletNode.port.onmessage = (event) => {
          if (ws.readyState === 1) { // OPEN
            ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(event.data) }));
          }
        };

        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0;
        source.connect(workletNode).connect(gainNode).connect(audioCtx.destination);

        // Send OpenAI Configuration
        ws.send(JSON.stringify({
            type: 'session.update',
            session: {
                modalities: ['audio', 'text'],
                instructions: lv.systemPrompt,
                voice: 'alloy',
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200 }
            }
        }));

        // Trigger AI to speak first
        ws.send(JSON.stringify({
           type: 'response.create',
           response: { modalities: ['audio', 'text'], instructions: '여보세요? 인사하세요.' }
        }));
        
        setIsConnecting(false);
        setScreen('calling');
        setVoiceState('listening'); // User mic is active

      } catch (err) {
        console.error('Mic error:', err);
        setMicError('마이크 권한을 허용해주세요.');
        stopAll();
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'response.audio.delta') {
          setVoiceState('ai-speaking');
          playAudioChunk(data.delta);
        } else if (data.type === 'input_audio_buffer.speech_started') {
           setVoiceState('listening');
        } else if (data.type === 'response.done') {
           setVoiceState('listening');
        } else if (data.type === 'response.audio_transcript.done') {
           setMessages(prev => [...prev, { role: 'assistant', content: data.transcript, time: Date.now() }]);
        } else if (data.type === 'conversation.item.input_audio_transcription.completed') {
           setMessages(prev => [...prev, { role: 'user', content: data.transcript, time: Date.now() }]);
        }
      } catch (e) {}
    };

    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      stopAll();
    };
  };

  const stopAll = () => {
    isEndingRef.current = true;
    if (wsRef.current) wsRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) audioCtxRef.current.close();
    clearInterval(timerRef.current);
    setVoiceState('idle');
  };

  const endCall = () => {
    stopAll();
    setFeedback(null); // Realtime API에서 상세 구조적 분석은 나중에!
    setScreen('feedback');
  };

  const resetAll = () => {
    stopAll();
    setScreen('home'); setLevel(null); setMessages([]);
    setFeedback(null); setCallDuration(0); setTranscript(''); setInterimTranscript('');
    setShowCustom(false);
  };

  const startCustomCall = () => {
    if (!customTitle.trim() || !customRole.trim() || !customScenario.trim()) return;
    const isCalling = customDirection === 'calling';
    const customLevel = {
      id: 'custom', title: customTitle.trim(), subtitle: \`Lv.\${customDifficulty} · 직접 입력\`,
      color: '#F472B6', darkColor: '#DB2777', difficulty: customDifficulty,
      description: customScenario.trim(), tip: '직접 만든 상황으로 연습해보세요', role: customRole.trim(), scenario: customScenario.trim(),
      systemPrompt: isCalling
        ? \`당신은 \${customRole.trim()}입니다. 상대방이 전화를 걸었습니다. 실제 상황처럼 대답하세요. 상황: \${customScenario.trim()}\`
        : \`당신은 \${customRole.trim()}입니다. 먼저 통화를 건 상태입니다. 상황에 맞게 용건을 말하세요. 상황: \${customScenario.trim()}\`
    };
    startCall(customLevel);
  };
  
  const handleTapToSpeak = () => {}; // Legacy (button still references it maybe)
`;

const startIndex = code.indexOf('  // ── TTS ───────────────────────────────────────────────────');
const endIndex = code.indexOf('  return (', startIndex);
if (startIndex !== -1 && endIndex !== -1) {
    let newCode = code.substring(0, startIndex) + replacement + code.substring(endIndex);
    fs.writeFileSync('d:/구글안티그래비티/callphobia-app/src/VoiceCallTrainer.js', newCode);
    console.log('REPLACED SUCCESSFULLY');
} else {
    console.log('INDICES NOT FOUND', startIndex, endIndex);
}
