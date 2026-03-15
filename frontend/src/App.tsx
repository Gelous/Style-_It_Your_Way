import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Mic, Shirt, Sparkles, ShoppingBag, LayoutGrid, TrendingUp, Image as ImageIcon, UserCircle, RefreshCw, Save, Heart, ExternalLink, X, FileText, Store, ChevronUp, ChevronDown, LogOut, Mail, Lock, UserPlus, LogIn } from 'lucide-react';

const App: React.FC = () => {
  const [user, setUser] = useState<{ id: string; email: string; name: string; sex: string; basicPreferences: string } | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authSex, setAuthSex] = useState('unspecified');
  const [authBasicPreferences, setAuthBasicPreferences] = useState('');
  const [authError, setAuthError] = useState('');

  const [activeTab, setActiveTab] = useState('stylist');
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  
  const [styleGallery, setStyleGallery] = useState<any[]>([]);
  const [feedIndex, setFeedIndex] = useState(0);
  const [closet, setCloset] = useState<any[]>([]);
  const [insights, setInsights] = useState({ suggestions: 'Waiting...', improvements: '', recommendations: '' });

  const nextItem = () => {
    if (styleGallery.length > 0) {
      setFeedIndex((prev) => {
        const next = prev + 1;
        // If we are getting close to the end, ask for more items silently
        if (next === styleGallery.length - 1 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ text: "Generate 5 more new style gallery options based on my target goal from Google Shop." }));
        }
        return next % styleGallery.length;
      });
    }
  };

  const prevItem = () => {
    if (styleGallery.length > 0) {
      setFeedIndex((prev) => (prev - 1 + styleGallery.length) % styleGallery.length);
    }
  };

  const [preferences, setPreferences] = useState('');
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inspirationInputRef = useRef<HTMLInputElement>(null);
  const currentLookInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartTime = useRef(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Load user from localStorage
  useEffect(() => {
    const savedUser = localStorage.getItem('styleSenseUser');
    if (savedUser) setUser(JSON.parse(savedUser));
  }, []);

  // Persistent Camera Stream acquisition
  useEffect(() => {
    if (!user) return;
    if (cameraStream) return;

    navigator.mediaDevices.getUserMedia({ video: true })
      .then((stream) => setCameraStream(stream))
      .catch((err) => console.error("Error accessing camera:", err));
  }, [user, cameraStream]);

  // Re-attach stream to video element when tab changes or stream initializes
  useEffect(() => {
    if (activeTab === 'stylist' && videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [activeTab, cameraStream]);

  // Re-attach stream to video element whenever 'stylist' tab is active
  useEffect(() => {
    if (activeTab === 'stylist' && cameraStreamRef.current) {
        const timer = setTimeout(() => {
            if (videoRef.current) {
                videoRef.current.srcObject = cameraStreamRef.current;
            }
        }, 100);
        return () => clearTimeout(timer);
    }
  }, [activeTab]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = authMode === 'login' ? '/api/login' : '/api/signup';
    try {
        const payload = authMode === 'signup'
          ? { email: authEmail, password: authPassword, name: authName, sex: authSex, basicPreferences: authBasicPreferences }
          : { email: authEmail, password: authPassword };

        const res = await fetch(`http://localhost:3001${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
            setUser(data);
            localStorage.setItem('styleSenseUser', JSON.stringify(data));
        } else {
            setAuthError(data.error || 'Authentication failed');
        }
    } catch (e) { setAuthError('Server connection failed'); }
  };

  const handleLogout = () => {
    disconnect();
    setUser(null);
    localStorage.removeItem('styleSenseUser');
  };

  const connect = useCallback(async () => {
    if (!user) return;

    // Create AudioContext on a user gesture to satisfy browser policies (Chrome/Firefox/Safari)
    try {
        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        }
        if (audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume();
        }
    } catch(e) {
        console.error("Failed to initialize audio context", e);
    }

    const ws = new WebSocket(`ws://localhost:4002?userId=${user.id}`);
    wsRef.current = ws;
    ws.onopen = () => {
      setIsConnected(true);
      if (audioContextRef.current) {
          nextStartTime.current = audioContextRef.current.currentTime;
      }
    };
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = async (event) => {
      setIsProcessing(false); // AI responded, hide processing indicator
      const data = JSON.parse(event.data);
      if (data.audio) playAudioChunk(data.audio);
      if (data.toolCallResult) {
        const { name, result } = data.toolCallResult;
        console.log(`DEBUG: Tool Result [${name}]:`, result);
        if (name === 'update_style_insights') setInsights(result);
        if (name === 'generate_style_batch') {
            setStyleGallery(prev => {
                // If it's empty, set feedIndex to 0. If it's appending, just add.
                if (prev.length === 0) { setFeedIndex(0); return result.suggestions; }
                return [...prev, ...result.suggestions];
            });
        }
        if (name === 'get_closet') setCloset(result.items);
        if (name === 'add_to_closet') setCloset(prev => [...prev, result.item]);
      }
    };
  }, [user]);

  const interruptAI = useCallback(() => {
    if (audioContextRef.current) {
      // Stop all actively playing sources in the queue
      activeSourcesRef.current.forEach(source => {
        try { source.stop(); } catch(e) {}
      });
      activeSourcesRef.current = [];
      // Reset the start time so new audio starts playing immediately
      nextStartTime.current = audioContextRef.current.currentTime;
      // Also send a special message or just let the real-time audio from microphone naturally interrupt Gemini
      // But clearing the local playback buffer is required so we don't hear stale queued sentences.
    }
  }, []);

  const disconnect = useCallback(() => { wsRef.current?.close(); interruptAI(); }, [interruptAI]);

  const nextItem = useCallback(() => {
    if (styleGallery.length > 0) {
      setFeedIndex((prev) => (prev + 1) % styleGallery.length);
    }
  }, [styleGallery.length]);

  const prevItem = useCallback(() => {
    if (styleGallery.length > 0) {
      setFeedIndex((prev) => (prev - 1 + styleGallery.length) % styleGallery.length);
    }
  }, [styleGallery.length]);

  // Send camera frames to Gemini
  useEffect(() => {
    if (!isConnected || !videoRef.current) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const interval = setInterval(() => {
      if (videoRef.current && ctx && wsRef.current?.readyState === WebSocket.OPEN) {
        const video = videoRef.current;
        // Use full video dimensions to avoid cropping
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
        
        wsRef.current.send(JSON.stringify({
          realtimeInput: {
            video: { mimeType: 'image/jpeg', data: base64 }
          }
        }));
      }
    }, 1000); // Send every 1000ms (more stable)

    return () => clearInterval(interval);
  }, [isConnected, activeTab]);

  const analyzeNow = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      interruptAI();
      setIsProcessing(true);
      wsRef.current.send(JSON.stringify({ text: "Analyze my look and update the visual gallery with 6 new suggestions." }));
    }
  };

  const clearSession = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ text: "CLEAR CONTEXT: Forget our previous conversation and start fresh with my current Target Aesthetic." }));
    }
    setMessages([]);
    setStyleGallery([]);
    setInsights({ suggestions: 'Waiting...', improvements: '', recommendations: '' });
  };

  const handleLike = (item: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      interruptAI();
      setIsProcessing(true);
      wsRef.current.send(JSON.stringify({ text: `I love the "${item.name}" suggestion. Add it to my closet.` }));
    }
  };

  const playAudioChunk = async (base64Audio: string) => {
    if (!audioContextRef.current) return;
    const audioCtx = audioContextRef.current;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const binary = window.atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x7FFF;
    const audioBuffer = audioCtx.createBuffer(1, pcm16.length, 24000);
    audioBuffer.getChannelData(0).set(float32);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    // Cleanup reference when audio finishes playing
    source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
    };
    activeSourcesRef.current.push(source);

    const now = audioCtx.currentTime;
    if (nextStartTime.current < now) nextStartTime.current = now + 0.1;
    source.start(nextStartTime.current);
    nextStartTime.current += audioBuffer.duration;
  };

  const startRecording = async () => {
    interruptAI(); // User spoke, cut off AI playback locally immediately
    try {
      // Re-use or create audio context
      if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true } });
      mediaStreamRef.current = stream;
      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
          const buffer = new ArrayBuffer(pcm16.length * 2);
          const view = new DataView(buffer);
          pcm16.forEach((val, i) => view.setInt16(i * 2, val, true));
          let binary = '';
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          const base64Audio = window.btoa(binary);
          wsRef.current.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64Audio }] } }));
        }
      };
      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
      setIsRecording(true);
    } catch (err) { console.error("Error accessing microphone:", err); }
  };

  const stopRecording = () => {
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (mediaStreamRef.current) { mediaStreamRef.current.getTracks().forEach(t => t.stop()); mediaStreamRef.current = null; }
    setIsRecording(false);
    setIsProcessing(true); // After user finishes recording, expect processing
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'inspiration' | 'current_look') => {
    const file = e.target.files?.[0];
    if (file && wsRef.current?.readyState === WebSocket.OPEN) {
      setIsProcessing(true);
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        wsRef.current?.send(JSON.stringify({
          text: `[User uploaded a ${type.replace('_', ' ')} image]`,
          realtimeInput: { mediaChunks: [{ mimeType: file.type, data: base64 }] }
        }));
      };
      reader.readAsDataURL(file);
    }
  };

  // Condition rendering for Login/Signup
  if (!user) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white font-sans flex items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-purple-900/20 via-neutral-950 to-neutral-950">
        <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-[2.5rem] p-10 shadow-2xl">
          <div className="text-center mb-10">
            <div className="w-16 h-16 bg-purple-600 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-purple-500/20">
              <ShoppingBag className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold mb-2">StyleSense <span className="text-purple-500">PRO</span></h1>
            <p className="text-neutral-400 text-sm">{authMode === 'login' ? 'Welcome back! Your personal coach is waiting.' : 'Start your personal style journey today.'}</p>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            {authMode === 'signup' && (
              <div className="relative group">
                <UserCircle className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500 group-focus-within:text-purple-500 transition" />
                <input
                  type="text" required placeholder="Full Name"
                  value={authName} onChange={(e) => setAuthName(e.target.value)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-2xl py-4 pl-12 pr-4 outline-none focus:border-purple-500 transition text-sm"
                />
              </div>
            )}
            <div className="relative group">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500 group-focus-within:text-purple-500 transition" />
              <input 
                type="email" required placeholder="Email Address" 
                value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-2xl py-4 pl-12 pr-4 outline-none focus:border-purple-500 transition text-sm"
              />
            </div>
            <div className="relative group">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500 group-focus-within:text-purple-500 transition" />
              <input 
                type="password" required placeholder="Password" 
                value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-2xl py-4 pl-12 pr-4 outline-none focus:border-purple-500 transition text-sm"
              />
            </div>
            
            {authMode === 'signup' && (
              <>
                <div className="relative group">
                  <UserCircle className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500 group-focus-within:text-purple-500 transition" />
                  <select
                    value={authSex} onChange={(e) => setAuthSex(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-2xl py-4 pl-12 pr-4 outline-none focus:border-purple-500 transition text-sm text-neutral-400 appearance-none"
                  >
                    <option value="unspecified">Prefer not to say</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="non-binary">Non-binary</option>
                  </select>
                </div>
                <div className="relative group">
                  <Shirt className="absolute left-4 top-4 w-5 h-5 text-neutral-500 group-focus-within:text-purple-500 transition" />
                  <textarea
                    placeholder="Basic Preferences (e.g. I only wear black, I love oversized fits, no synthetic fabrics)"
                    value={authBasicPreferences} onChange={(e) => setAuthBasicPreferences(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-2xl py-4 pl-12 pr-4 outline-none focus:border-purple-500 transition text-sm resize-none h-24"
                  />
                </div>
              </>
            )}

            {authError && <p className="text-red-500 text-xs text-center font-medium bg-red-500/10 py-2 rounded-lg">{authError}</p>}

            <button type="submit" className="w-full bg-white text-black font-bold py-4 rounded-2xl hover:bg-neutral-200 transition-all shadow-xl shadow-white/5 flex items-center justify-center gap-2 mt-6">
              {authMode === 'login' ? <LogIn className="w-5 h-5" /> : <UserPlus className="w-5 h-5" />}
              {authMode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          <div className="mt-8 text-center text-sm">
            <button onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')} className="text-neutral-400 hover:text-white transition">
              {authMode === 'login' ? "Don't have an account? " : "Already have an account? "}
              <span className="text-purple-500 font-bold ml-1 hover:underline">{authMode === 'login' ? 'Sign Up' : 'Log In'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main App Content (when logged in)
  return (
    <div className="min-h-screen bg-neutral-950 text-white font-sans flex overflow-hidden">
      <div className="w-80 p-6 border-r border-neutral-800 flex flex-col gap-6 bg-neutral-900/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShoppingBag className="text-purple-400 w-8 h-8" />
            <h1 className="text-xl font-bold tracking-tight">StyleSense <span className="text-purple-500">PRO</span></h1>
          </div>
          <button onClick={handleLogout} className="p-2 hover:bg-neutral-800 rounded-lg text-neutral-500 hover:text-red-400 transition" title="Logout"><LogOut className="w-5 h-5" /></button>
        </div>
        <div className="flex items-center gap-3 p-4 bg-neutral-900/50 border border-neutral-800 rounded-2xl">
            <div className="w-10 h-10 bg-purple-600 rounded-full flex items-center justify-center text-sm font-bold">{user.name ? user.name[0].toUpperCase() : user.email[0].toUpperCase()}</div>
            <div className="overflow-hidden">
                <p className="text-[10px] text-neutral-500 uppercase font-bold tracking-widest">Logged In As</p>
                <p className="text-xs font-medium truncate">{user.name || user.email}</p>
            </div>
        </div>
        <nav className="flex flex-col gap-2">
          <button onClick={() => setActiveTab('stylist')} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition ${activeTab === 'stylist' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'hover:bg-neutral-800 text-neutral-400'}`}><Camera className="w-5 h-5" /> Live Stylist</button>
          <button onClick={() => setActiveTab('closet')} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition ${activeTab === 'closet' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'hover:bg-neutral-800 text-neutral-400'}`}><LayoutGrid className="w-5 h-5" /> My Closet</button>
          <button onClick={() => setActiveTab('trends')} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition ${activeTab === 'trends' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'hover:bg-neutral-800 text-neutral-400'}`}><TrendingUp className="w-5 h-5" /> Style Trends</button>
        </nav>
        <div className="mt-auto flex flex-col gap-4">
           <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Target Aesthetic</span>
            <div className="flex gap-2">
              <textarea value={preferences} onChange={(e) => setPreferences(e.target.value)} placeholder="e.g. Minimalist" className="flex-1 bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-sm h-20 outline-none focus:border-purple-500 transition resize-none" />
              <button onClick={() => wsRef.current?.send(JSON.stringify({ text: `Update Goal: ${preferences}` }))} disabled={!isConnected} className="p-3 bg-neutral-800 rounded-lg hover:bg-neutral-700 transition self-end"><Save className="w-4 h-4 text-purple-400" /></button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {!isConnected ? <button onClick={connect} className="col-span-2 bg-white text-black py-3 rounded-xl font-bold hover:bg-neutral-200 transition">START</button> : <button onClick={() => wsRef.current?.close()} className="col-span-2 bg-red-500/10 text-red-500 border border-red-500/20 py-3 rounded-xl font-bold">STOP</button>}
            <button onClick={analyzeNow} disabled={!isConnected} className={`col-span-2 p-3 rounded-xl transition flex items-center justify-center gap-2 ${!isConnected ? 'bg-neutral-800 text-neutral-500' : 'bg-purple-600/20 text-purple-400 border border-purple-500/20 hover:bg-purple-600/30'}`}><RefreshCw className={`w-4 h-4 ${isConnected ? 'animate-spin-slow' : ''}`} /><span className="text-xs font-bold uppercase">Analyze My Look</span></button>
            <button onClick={clearSession} disabled={!isConnected} className={`col-span-2 p-3 rounded-xl transition flex items-center justify-center gap-2 ${!isConnected ? 'bg-neutral-800 text-neutral-500' : 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20'}`}><X className="w-4 h-4" /><span className="text-xs font-bold uppercase">Clear Chat</span></button>
            <input type="file" ref={inspirationInputRef} onChange={(e) => handleFileUpload(e, 'inspiration')} accept="image/*" className="hidden" />
            <button onClick={() => inspirationInputRef.current?.click()} disabled={!isConnected} className={`p-3 rounded-xl transition flex flex-col items-center gap-1 ${!isConnected ? 'bg-neutral-800 text-neutral-500' : 'bg-neutral-800 text-purple-400 hover:bg-neutral-700'}`}><ImageIcon className="w-5 h-5" /><span className="text-[10px] font-bold uppercase">Inspo</span></button>
            <input type="file" ref={currentLookInputRef} onChange={(e) => handleFileUpload(e, 'current_look')} accept="image/*" className="hidden" />
            <button onClick={() => currentLookInputRef.current?.click()} disabled={!isConnected} className={`p-3 rounded-xl transition flex flex-col items-center gap-1 ${!isConnected ? 'bg-neutral-800 text-neutral-500' : 'bg-neutral-800 text-pink-400 hover:bg-neutral-700'}`}><UserCircle className="w-5 h-5" /><span className="text-[10px] font-bold uppercase">Current</span></button>
            <button onMouseDown={startRecording} onMouseUp={stopRecording} onMouseLeave={stopRecording} disabled={!isConnected} className={`col-span-2 p-3 rounded-xl transition flex items-center justify-center gap-2 ${isRecording ? 'bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.4)]' : 'bg-neutral-800 text-white hover:bg-neutral-700'}`}>{isRecording ? <div className="flex gap-1 items-center"><div className="w-1 h-4 bg-white animate-pulse" /><div className="w-1 h-6 bg-white animate-pulse delay-75" /><div className="w-1 h-4 bg-white animate-pulse delay-150" /></div> : <Mic className="w-5 h-5" />}<span className="text-xs font-bold uppercase">Push to Talk</span></button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        {activeTab === 'stylist' && (
          <div className="flex-1 flex gap-6 p-8 overflow-hidden relative">
            <div className="flex-1 flex flex-col gap-6 relative">
              <div className="relative h-[500px] rounded-3xl overflow-hidden bg-neutral-900 border border-neutral-800 shadow-2xl shrink-0">
                <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-contain transform scale-x-[-1]" />
                <div className={`absolute top-6 left-6 flex items-center gap-2 px-3 py-1.5 bg-black/40 backdrop-blur-xl border border-white/10 rounded-full text-[10px] font-bold ${isConnected ? 'text-white' : 'text-neutral-500'}`}><div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-red-500 animate-pulse' : 'bg-neutral-700'}`} /> {isConnected ? 'LIVE' : 'INACTIVE'}</div>
              </div>
              
              <div className="flex-1 rounded-3xl border border-neutral-800 bg-neutral-900/40 relative overflow-hidden flex items-center justify-center p-4">
                {styleGallery.length > 0 ? (
                  <div className="w-full h-full relative">
                    <img 
                        src={styleGallery[feedIndex].imageUrl} alt="Style Suggestion" 
                        className="w-full h-full object-contain rounded-2xl animate-in fade-in zoom-in-95 duration-500" 
                        onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            const currentSrc = target.src;
                            
                            // 1. If original failed, try Pollinations AI
                            if (!currentSrc.includes('pollinations.ai')) {
                                const keyword = encodeURIComponent(`${styleGallery[feedIndex].style_keyword || styleGallery[feedIndex].name || 'fashion'} high quality editorial`);
                                target.src = `https://image.pollinations.ai/prompt/${keyword}?width=800&height=1000&nologo=true&seed=${Date.now()}`;
                            } 
                            // 2. If Pollinations failed too (or we already tried it), use a reliable Unsplash fashion ID
                            else {
                                const fashionFallbacks = ['1515886657613-9f3515b0c78f', '1434389677669-e08b4cac3105', '1591047139829-d91aecb6caea'];
                                const randomId = fashionFallbacks[Math.floor(Math.random() * fashionFallbacks.length)];
                                target.src = `https://images.unsplash.com/photo-${randomId}?q=80&w=800&auto=format&fit=crop`;
                            }
                        }}
                    />
                    <div className="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col gap-4 z-10">
                        <button onClick={prevItem} className="p-3 bg-black/60 rounded-full hover:bg-purple-600 transition shadow-xl"><ChevronUp className="w-6 h-6" /></button>
                        <button onClick={nextItem} className="p-3 bg-black/60 rounded-full hover:bg-purple-600 transition shadow-xl"><ChevronDown className="w-6 h-6" /></button>
                    </div>
                    <div className="absolute bottom-6 left-6 right-6 flex items-end justify-between bg-gradient-to-t from-black/80 to-transparent p-6 rounded-b-2xl">
                        <div className="max-w-[60%]">
                            <h4 className="text-xl font-bold text-white mb-1">{styleGallery[feedIndex].name}</h4>
                            <p className="text-xs text-neutral-300 line-clamp-2">{styleGallery[feedIndex].reason}</p>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => handleLike(styleGallery[feedIndex])} className="p-3 bg-white/10 backdrop-blur-md rounded-2xl hover:bg-pink-500/20 transition group border border-white/10"><Heart className="w-5 h-5 text-white group-hover:text-pink-500 transition" /></button>
                            <button 
                                onClick={() => window.open(styleGallery[feedIndex].shop_url, '_blank')}
                                className="px-4 py-3 bg-purple-600 text-white rounded-2xl hover:bg-purple-500 transition shadow-xl flex items-center gap-2 border border-purple-400/20"
                            >
                                <ShoppingBag className="w-5 h-5" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">Shop</span>
                            </button>
                            <button onClick={() => setSelectedItem(styleGallery[feedIndex])} className="p-3 bg-white/10 backdrop-blur-md rounded-2xl hover:bg-white/20 transition border border-white/10"><Store className="w-5 h-5 text-white" /></button>
                        </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center"><Sparkles className="w-8 h-8 text-purple-500 mx-auto mb-3 opacity-50" /><p className="text-neutral-500 text-sm">Targeting real-world styles for you...</p></div>
                )}
              </div>
            </div>

            <div className="w-96 flex flex-col gap-6">
              <div className="p-6 rounded-3xl bg-white text-black shadow-xl shrink-0">
                <h3 className="font-bold flex items-center justify-between mb-4 text-neutral-900">
                  <div className="flex items-center gap-2"><Shirt className="w-4 h-4" /> Advice Summary</div>
                  {isProcessing && <div className="flex gap-1 items-center"><div className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce"></div><div className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce [animation-delay:-.3s]"></div><div className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce [animation-delay:-.5s]"></div></div>}
                </h3>
                <div className="flex flex-col gap-3 text-sm">
                  <p className="font-medium leading-relaxed">{insights.improvements || 'Coach is analyzing your style and speaking aloud...'}</p>
                  <button onClick={() => setShowReport(true)} disabled={!isConnected} className={`flex items-center gap-2 font-bold text-xs mt-2 transition ${!isConnected ? 'text-neutral-400 cursor-not-allowed' : 'text-purple-600 hover:text-purple-800'}`}><FileText className="w-4 h-4" /> FULL ANALYSIS</button>
                </div>
              </div>
            </div>

            {showReport && (
              <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-10">
                <div className="bg-neutral-900 border border-neutral-800 w-full max-w-2xl rounded-3xl p-8 flex flex-col max-h-[80vh] shadow-2xl text-white">
                  <div className="flex justify-between items-center mb-6"><h2 className="text-2xl font-bold flex items-center gap-3"><FileText className="text-purple-500" /> Style Report</h2><button onClick={() => setShowReport(false)} className="p-2 hover:bg-neutral-800 rounded-full"><X /></button></div>
                  <div className="flex-1 overflow-y-auto space-y-6 text-neutral-300 pr-4 custom-scrollbar">
                    <section><h4 className="text-white font-bold mb-2 uppercase text-[10px] tracking-widest text-purple-400">Executive Summary</h4><p className="leading-relaxed bg-neutral-800/50 p-4 rounded-2xl border border-neutral-700/50">{insights.summary}</p></section>
                    <section><h4 className="text-white font-bold mb-2 uppercase text-[10px] tracking-widest text-purple-400">Pro Tip</h4><p className="leading-relaxed bg-purple-900/20 p-4 rounded-2xl border border-purple-500/30 text-white font-medium italic">"{insights.top_tip}"</p></section>
                    <section><h4 className="text-white font-bold mb-2 uppercase text-[10px] tracking-widest text-purple-400">Full Coaching Advice</h4><p className="leading-relaxed bg-neutral-800/50 p-4 rounded-2xl border border-neutral-700/50 text-sm whitespace-pre-wrap">{insights.vocal_script}</p></section>
                  </div>
                </div>
              </div>
            )}

            {selectedItem && (
              <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-10">
                <div className="bg-neutral-900 border border-neutral-800 w-full max-w-4xl rounded-3xl overflow-hidden flex shadow-2xl h-[70vh] text-white">
                  <img src={selectedItem.imageUrl} className="w-1/2 object-cover" onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      if (!target.src.includes('pollinations.ai')) {
                        const keyword = encodeURIComponent(`${selectedItem.style_keyword || selectedItem.name || 'fashion'} fashion editorial`);
                        target.src = `https://image.pollinations.ai/prompt/${keyword}?width=800&height=1000&nologo=true&seed=${Date.now()}`;
                      } else {
                        target.src = `https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?q=80&w=800&auto=format&fit=crop`;
                      }
                  }} />
                  <div className="w-1/2 p-10 flex flex-col h-full bg-neutral-900">
                    <div className="flex justify-between items-start mb-6"><div><h2 className="text-3xl font-bold mb-2">{selectedItem.name}</h2><p className="text-neutral-400 text-sm">{selectedItem.reason}</p></div><button onClick={() => setSelectedItem(null)} className="p-2 hover:bg-neutral-800 rounded-full"><X /></button></div>
                    <div className="mt-auto">
                        <h4 className="font-bold flex items-center gap-2 mb-4 text-purple-400 uppercase text-xs tracking-widest"><Store className="w-4 h-4" /> Retail Locations</h4>
                        <div className="grid grid-cols-1 gap-3">
                            {selectedItem.retailers?.map((r: string) => (
                                <div 
                                    key={r} 
                                    onClick={() => window.open(`https://www.google.com/search?q=${encodeURIComponent(selectedItem.name + " " + r)}`, '_blank')}
                                    className="flex items-center justify-between p-4 bg-neutral-800/50 rounded-2xl border border-neutral-700 hover:border-purple-500 transition group cursor-pointer"
                                >
                                    <span className="font-medium text-sm">{r}</span>
                                    <ExternalLink className="w-4 h-4 text-neutral-500 group-hover:text-purple-400" />
                                </div>
                            ))}
                        </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {activeTab === 'closet' && <div className="flex-1 p-8 overflow-y-auto text-white"><h2 className="text-3xl font-bold mb-8">My Closet</h2><div className="grid grid-cols-4 gap-6">{closet.map((item, i) => <div key={i} onClick={() => setSelectedItem(item)} className="group relative rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-900/40 cursor-pointer hover:border-purple-500 transition shadow-xl aspect-[3/4]"><img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover transition duration-500 group-hover:scale-105" /><div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent opacity-0 group-hover:opacity-100 transition p-4 flex flex-col justify-end"><h4 className="font-bold text-white text-sm">{item.name}</h4></div></div>)}</div></div>}
        {activeTab === 'trends' && (
          <div className="flex-1 p-8 overflow-y-auto text-white">
            <h2 className="text-3xl font-bold mb-8 flex items-center gap-3"><TrendingUp className="text-purple-500" /> Global Style Trends</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                { title: 'Y2K Revival', desc: 'Low-rise jeans, baby tees, and metallic accessories are dominating street style this season.', tags: ['Vintage', 'Streetwear'] },
                { title: 'Quiet Luxury', desc: 'Elevated basics, neutral tones, and focus on high-quality fabrics without visible logos.', tags: ['Minimalist', 'Elegant'] },
                { title: 'Gorpcore', desc: 'Functional outdoor gear worn as everyday fashion. Think cargo pants and technical jackets.', tags: ['Utility', 'Casual'] },
                { title: 'Corporate Core', desc: 'Oversized blazers, tailored trousers, and loafers mixed with casual elements.', tags: ['Office', 'Chic'] },
                { title: 'Balletcore', desc: 'Wrap tops, leg warmers, tulle skirts, and ballet flats bringing soft feminine energy.', tags: ['Feminine', 'Soft'] },
                { title: 'Eclectic Grandpa', desc: 'Sweater vests, colorful cardigans, and retro sneakers paired playfully.', tags: ['Retro', 'Comfort'] }
              ].map((trend, i) => (
                <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-3xl p-6 hover:border-purple-500 transition cursor-pointer group shadow-xl">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-xl font-bold text-white group-hover:text-purple-400 transition">{trend.title}</h3>
                    <Sparkles className="w-5 h-5 text-neutral-600 group-hover:text-purple-500 transition" />
                  </div>
                  <p className="text-neutral-400 text-sm mb-6 leading-relaxed">{trend.desc}</p>
                  <div className="flex flex-wrap gap-2">
                    {trend.tags.map(tag => (
                      <span key={tag} className="text-[10px] uppercase tracking-widest font-bold px-3 py-1 bg-neutral-800 text-neutral-300 rounded-full border border-neutral-700">{tag}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
