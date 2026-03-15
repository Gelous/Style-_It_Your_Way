import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Mic, MicOff, Play, Square, Shirt, Sparkles, ShoppingBag, LayoutGrid, TrendingUp, Search, PlusCircle, Image as ImageIcon, UserCircle, RefreshCw, Save, Heart, ExternalLink, X, FileText, Store, Globe, Info, ChevronUp, ChevronDown, LogOut, Mail, Lock, UserPlus, LogIn } from 'lucide-react';

const App: React.FC = () => {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');

  const [activeTab, setActiveTab] = useState('stylist');
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  
  const [styleGallery, setStyleGallery] = useState<any[]>([]);
  const [feedIndex, setFeedIndex] = useState(0);
  const [closet, setCloset] = useState<any[]>([]);
  const [insights, setInsights] = useState({ suggestions: 'Waiting...', improvements: '', recommendations: '' });

  const [preferences, setPreferences] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const inspirationInputRef = useRef<HTMLInputElement>(null);
  const currentLookInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTime = useRef(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Load user from localStorage
  useEffect(() => {
    const savedUser = localStorage.getItem('styleSenseUser');
    if (savedUser) setUser(JSON.parse(savedUser));
  }, []);

  // Persistent Camera Initialization
  useEffect(() => {
    if (!user) return;
    
    const startCamera = async () => {
        try {
            if (!cameraStreamRef.current) {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                cameraStreamRef.current = stream;
            }
            if (activeTab === 'stylist' && videoRef.current) {
                videoRef.current.srcObject = cameraStreamRef.current;
            }
        } catch (err) {
            console.error("Error accessing camera:", err);
        }
    };

    startCamera();

    return () => {
        // We keep it running for the AI's vision, but we could stop it on logout
    };
  }, [user, activeTab]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = authMode === 'login' ? '/api/login' : '/api/signup';
    try {
        const res = await fetch(`http://localhost:3001${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: authEmail, password: authPassword })
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

  const playAudio = useCallback(async (base64Data: string) => {
    if (!audioContextRef.current) return;
    try {
        const binaryString = window.atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        
        // Gemini Live usually sends 16-bit Mono PCM @ 24kHz
        const floatData = new Float32Array(bytes.length / 2);
        for (let i = 0; i < floatData.length; i++) {
            const int16 = (bytes[i * 2 + 1] << 8) | bytes[i * 2];
            floatData[i] = (int16 >= 0x8000 ? int16 - 0x10000 : int16) / 32768.0;
        }

        const audioBuffer = audioContextRef.current.createBuffer(1, floatData.length, 24000);
        audioBuffer.getChannelData(0).set(floatData);

        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContextRef.current.destination);

        const startTime = Math.max(nextStartTime.current, audioContextRef.current.currentTime);
        source.start(startTime);
        nextStartTime.current = startTime + audioBuffer.duration;
    } catch (err) { console.error("Error playing audio:", err); }
  }, []);

  const connect = useCallback(() => {
    if (!user) return;
    const ws = new WebSocket(`ws://localhost:4002?userId=${user.id}`);
    wsRef.current = ws;
    ws.onopen = () => {
      setIsConnected(true);
      setMessages((prev) => [...prev, { role: 'system', text: 'Coach Connected' }]);
      if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      nextStartTime.current = audioContextRef.current.currentTime;
    };
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log("DEBUG: Received from Backend:", data);

      if (data.text) setMessages((prev) => [...prev, { role: 'ai', text: data.text }]);
      if (data.audio) playAudio(data.audio);

      if (data.toolCallResult) {
        const { name, result } = data.toolCallResult;
        console.log(`DEBUG: Tool Result [${name}]:`, result);
        if (name === 'update_style_insights') setInsights(result);
        if (name === 'generate_style_batch') { 
            console.log("DEBUG: New Style Gallery Data:", result.suggestions);
            setStyleGallery(result.suggestions); 
            setFeedIndex(0); 
        }
        if (name === 'get_closet') setCloset(result.items);
        if (name === 'add_to_closet') setCloset(prev => [...prev, result.item]);
      }
    };
  }, [user]);

  const disconnect = useCallback(() => { wsRef.current?.close(); }, []);

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
        const size = Math.min(video.videoWidth, video.videoHeight) || 640;
        canvas.width = size;
        canvas.height = size;
        
        const startX = (video.videoWidth - size) / 2;
        const startY = (video.videoHeight - size) / 2;
        
        ctx.drawImage(video, startX, startY, size, size, 0, 0, size, size);
        const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
        
        wsRef.current.send(JSON.stringify({
          realtimeInput: {
            video: { mimeType: 'image/jpeg', data: base64 }
          }
        }));
      }
    }, 1000); // Send every 1000ms (more stable)

    return () => clearInterval(interval);
  }, [isConnected]);

  const analyzeNow = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
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
    const now = audioCtx.currentTime;
    if (nextStartTime.current < now) nextStartTime.current = now + 0.1;
    source.start(nextStartTime.current);
    nextStartTime.current += audioBuffer.duration;
  };

  const startRecording = async () => {
    try {
      if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
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
    } catch (err) { console.error(err); }
  };

  const stopRecording = () => {
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (mediaStreamRef.current) { mediaStreamRef.current.getTracks().forEach(t => t.stop()); mediaStreamRef.current = null; }
    setIsRecording(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'inspiration' | 'current_look') => {
    const file = e.target.files?.[0];
    if (file && wsRef.current?.readyState === WebSocket.OPEN) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        wsRef.current?.send(JSON.stringify({
          text: `[User uploaded a ${type.replace('_', ' ')} image]`,
          realtimeInput: { mediaChunks: [{ mimeType: file.type, data: base64 }] }
        }));
        setMessages(prev => [...prev, { role: 'system', text: `Uploaded ${type.replace('_', ' ')}` }]);
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
            <div className="w-10 h-10 bg-purple-600 rounded-full flex items-center justify-center text-sm font-bold">{user.email[0].toUpperCase()}</div>
            <div className="overflow-hidden">
                <p className="text-[10px] text-neutral-500 uppercase font-bold tracking-widest">Logged In As</p>
                <p className="text-xs font-medium truncate">{user.email}</p>
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
                <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover transform scale-x-[-1] brightness-110 contrast-105" />
                <div className={`absolute top-6 left-6 flex items-center gap-2 px-3 py-1.5 bg-black/40 backdrop-blur-xl border border-white/10 rounded-full text-[10px] font-bold ${isConnected ? 'text-white' : 'text-neutral-500'}`}><div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-red-500 animate-pulse' : 'bg-neutral-700'}`} /> {isConnected ? 'LIVE' : 'INACTIVE'}</div>
              </div>
              
              <div className="flex-1 rounded-3xl border border-neutral-800 bg-neutral-900/40 relative overflow-hidden flex flex-col items-center justify-center p-4">
                {styleGallery.length > 0 ? (
                  <div className="w-full h-full relative flex flex-col items-center">
                    <img 
                        src={styleGallery[feedIndex].imageUrl} alt="Look" 
                        className="w-full h-full object-contain rounded-2xl animate-in fade-in zoom-in-95 duration-500" 
                        onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            const keyword = encodeURIComponent(`${styleGallery[feedIndex].style_keyword || styleGallery[feedIndex].name} fashion editorial`);
                            if (!target.src.includes('pollinations.ai')) {
                                target.src = `https://image.pollinations.ai/prompt/${keyword}?width=800&height=1000&nologo=true&seed=${Date.now()}`;
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
                <h3 className="font-bold flex items-center gap-2 mb-4 text-neutral-900"><Shirt className="w-4 h-4" /> Advice Summary</h3>
                <div className="flex flex-col gap-3 text-sm">
                  <p className="font-medium leading-relaxed">{insights.improvements || 'Coach is watching your feed...'}</p>
                  <button onClick={() => setShowReport(true)} disabled={!isConnected} className={`flex items-center gap-2 font-bold text-xs mt-2 transition ${!isConnected ? 'text-neutral-400 cursor-not-allowed' : 'text-purple-600 hover:text-purple-800'}`}><FileText className="w-4 h-4" /> FULL ANALYSIS</button>
                </div>
              </div>
              <div className="flex-1 flex flex-col rounded-3xl bg-neutral-900/40 border border-neutral-800 overflow-hidden">
                <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-4">{messages.map((m, i) => <div key={i} className={`p-4 rounded-2xl text-sm max-w-[90%] ${m.role === 'ai' ? 'bg-neutral-800 text-white self-start' : m.role === 'system' ? 'text-neutral-500 text-center italic text-xs w-full' : 'bg-purple-600 text-white self-end'}`}>{m.text}</div>)}</div>
              </div>
            </div>

            {showReport && (
              <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-10">
                <div className="bg-neutral-900 border border-neutral-800 w-full max-w-2xl rounded-3xl p-8 flex flex-col max-h-[80vh] shadow-2xl text-white">
                  <div className="flex justify-between items-center mb-6"><h2 className="text-2xl font-bold flex items-center gap-3"><FileText className="text-purple-500" /> Style Report</h2><button onClick={() => setShowReport(false)} className="p-2 hover:bg-neutral-800 rounded-full"><X /></button></div>
                  <div className="flex-1 overflow-y-auto space-y-6 text-neutral-300 pr-4 custom-scrollbar">
                    <section><h4 className="text-white font-bold mb-2 uppercase text-[10px] tracking-widest text-purple-400">Analysis</h4><p className="leading-relaxed bg-neutral-800/50 p-4 rounded-2xl border border-neutral-700/50">{insights.suggestions}</p></section>
                    <section><h4 className="text-white font-bold mb-2 uppercase text-[10px] tracking-widest text-purple-400">Detailed Roadmap</h4><p className="leading-relaxed bg-neutral-800/50 p-4 rounded-2xl border border-neutral-700/50 text-white font-medium">{insights.improvements}</p></section>
                    <section><h4 className="text-white font-bold mb-2 uppercase text-[10px] tracking-widest text-purple-400">Retailers</h4><p className="leading-relaxed bg-neutral-800/50 p-4 rounded-2xl border border-neutral-700/50">{insights.recommendations}</p></section>
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
                        const keyword = encodeURIComponent(`${selectedItem.style_keyword || selectedItem.name} fashion editorial`);
                        target.src = `https://image.pollinations.ai/prompt/${keyword}?width=800&height=1000&nologo=true&seed=${Date.now()}`;
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
        {activeTab === 'closet' && <div className="flex-1 p-8 overflow-y-auto text-white"><h2 className="text-3xl font-bold mb-8">My Closet</h2><div className="grid grid-cols-4 gap-6">{closet.map((item, i) => <div key={i} onClick={() => setSelectedItem(item)} className="group relative rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-900/40 cursor-pointer hover:border-purple-500 transition shadow-xl aspect-[3/4]"><img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover transition duration-500 group-hover:scale-105" onError={(e) => { const target = e.target as HTMLImageElement; if (!target.src.includes('pollinations.ai')) { const kw = encodeURIComponent(`${item.style_keyword || item.name} fashion editorial`); target.src = `https://image.pollinations.ai/prompt/${kw}?width=800&height=1000&nologo=true&seed=${Date.now()}`; } }} /><div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent opacity-0 group-hover:opacity-100 transition p-4 flex flex-col justify-end"><h4 className="font-bold text-white text-sm">{item.name}</h4></div></div>)}</div></div>}
      </div>
    </div>
  );
};

export default App;
