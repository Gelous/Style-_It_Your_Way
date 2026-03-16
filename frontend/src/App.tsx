import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Camera, Shirt, Sparkles, ShoppingBag, 
  LayoutGrid, TrendingUp, PlusCircle, Image as ImageIcon, 
  UserCircle, RefreshCw, Heart, ExternalLink, X, 
  Settings, Eye, LogOut, Trash2, Globe, Clock, Shield, Bell
} from 'lucide-react';
import './App.css';

interface StyleItem {
  name: string;
  reason: string;
  imageUrl: string;
  style_keyword?: string;
  shop_url?: string;
  retailers?: string[];
}

interface StyleInsights {
  suggestions?: string;
  summary?: string;
  improvements?: string;
  recommendations?: string;
  top_tip?: string;
  vocal_script?: string;
}

interface StyleSession {
  id: string;
  name: string;
  targetStyle: string;
  currentLook?: string;
  inspiration?: string;
  gallery: StyleItem[];
  insights: StyleInsights;
  messages: { role: string; text: string }[];
  timestamp: number;
}

const App: React.FC = () => {
  // Auth State
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // UI State
  const [activeTab, setActiveTab] = useState('live');
  const [rightPanelTab, setRightPanelTab] = useState<'insights' | 'report'>('insights');
  
  // Session State
  const [sessions, setSessions] = useState<StyleSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [pendingStyle, setPendingStyle] = useState<string | null>(null);

  // Real-time State
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  const [styleGallery, setStyleGallery] = useState<StyleItem[]>([]);
  const [insights, setInsights] = useState<StyleInsights>({ suggestions: 'Waiting...' });
  const [preferences, setPreferences] = useState('');
  const [currentLookImg, setCurrentLookImg] = useState<string | null>(null);
  const [inspirationImg, setInspirationImg] = useState<string | null>(null);

  // Closet State (Grouped by Style Album)
  const [closet, setCloset] = useState<Record<string, StyleItem[]>>({});

  // Settings State
  const [notifications, setNotifications] = useState(true);
  const [privacy, setPrivacy] = useState(false);

  // Trends State
  const [trends, setTrends] = useState<{title: string, source: string, time: string, trend: string}[]>([]);
  const [loadingTrends, setLoadingTrends] = useState(false);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const inspirationInputRef = useRef<HTMLInputElement>(null);
  const currentLookInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const [tempPreferences, setTempPreferences] = useState('');

  // --- Core Lifecycle ---

  const loadSession = useCallback((session: StyleSession) => {
    setCurrentSessionId(session.id);
    setPreferences(session.targetStyle);
    setTempPreferences(session.targetStyle);
    setStyleGallery(session.gallery || []);
    setInsights(session.insights || { suggestions: 'Waiting...' });
    setMessages(session.messages || []);
    setCurrentLookImg(session.currentLook || null);
    setInspirationImg(session.inspiration || null);
  }, []);

  const createNewSession = useCallback((style?: string) => {
    const newId = Date.now().toString();
    const newSession: StyleSession = {
      id: newId,
      name: `${style || 'New'} Session`,
      targetStyle: style || 'Minimalist',
      gallery: [],
      insights: { suggestions: 'Waiting...' },
      messages: [],
      timestamp: Date.now()
    };
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newId);
    setPreferences(newSession.targetStyle);
    setTempPreferences(newSession.targetStyle);
    setStyleGallery([]);
    setInsights({ suggestions: 'Waiting...' });
    setMessages([]);
    setCurrentLookImg(null);
    setInspirationImg(null);
  }, []);

  useEffect(() => {
    const savedUser = localStorage.getItem('styleSenseUser');
    if (savedUser) setUser(JSON.parse(savedUser));

    const savedCloset = localStorage.getItem('styleSenseClosetAlbums');
    if (savedCloset) setCloset(JSON.parse(savedCloset));

    const savedSessions = localStorage.getItem('styleSessions');
    if (savedSessions) {
      const parsed = JSON.parse(savedSessions);
      setSessions(parsed);
      if (parsed.length > 0) loadSession(parsed[0]);
    } else {
      createNewSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeTab === 'trends' && trends.length === 0) {
      setLoadingTrends(true);
      fetch('http://localhost:3001/api/trends')
        .then(res => res.json())
        .then(data => {
          setTrends(data);
          setLoadingTrends(false);
        })
        .catch(err => {
          console.error(err);
          setLoadingTrends(false);
        });
    }
  }, [activeTab, trends.length]);

  const handleStyleSubmit = () => {
    if (tempPreferences === preferences || !tempPreferences) return;

    if (messages.length > 1 || styleGallery.length > 0) {
      setPendingStyle(tempPreferences);
      setShowSavePrompt(true);
    } else {
      setPreferences(tempPreferences);
    }
  };

  const confirmNewSession = () => {
    if (pendingStyle) createNewSession(pendingStyle);
    setShowSavePrompt(false);
    setPendingStyle(null);
  };

  const saveCurrentSession = useCallback(() => {
    if (!currentSessionId) return;
    setSessions(prev => {
      const updated = prev.map(s => 
        s.id === currentSessionId 
          ? { 
              ...s, 
              targetStyle: preferences, 
              gallery: styleGallery, 
              insights: insights, 
              messages: messages,
              currentLook: currentLookImg || undefined,
              inspiration: inspirationImg || undefined
            } 
          : s
      );
      localStorage.setItem('styleSessions', JSON.stringify(updated));
      return updated;
    });
  }, [currentSessionId, preferences, styleGallery, insights, messages, currentLookImg, inspirationImg]);

  useEffect(() => {
    const timer = setTimeout(saveCurrentSession, 1500);
    return () => clearTimeout(timer);
  }, [saveCurrentSession]);

  // Audio State
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextAudioStartTimeRef = useRef<number>(0);

  const playPCMChunk = (base64: string) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        nextAudioStartTimeRef.current = audioContextRef.current.currentTime;
      }

      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume();
      }

      // Faster base64 to Uint8Array
      const binaryString = window.atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Convert 16-bit PCM to Float32
      const pcm16 = new Int16Array(bytes.buffer);
      const float32Data = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32Data[i] = pcm16[i] / 32768.0;
      }

      const audioBuffer = audioContextRef.current.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = audioContextRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContextRef.current.destination);

      const startTime = Math.max(audioContextRef.current.currentTime, nextAudioStartTimeRef.current);
      source.start(startTime);
      nextAudioStartTimeRef.current = startTime + audioBuffer.duration;
    } catch (err) {
      console.error("PCM Playback failed:", err);
    }
  };

  // Synchronize Preferences with AI Session
  useEffect(() => {
    if (isConnected && wsRef.current?.readyState === WebSocket.OPEN && preferences) {
      // Clear results immediately for instant feedback
      setStyleGallery([]);
      setInsights({ summary: 'Updating for new aesthetic...' });
      
      const timer = setTimeout(() => {
        wsRef.current?.send(JSON.stringify({ text: `Update Goal: ${preferences}` }));
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [preferences, isConnected]);

  // Video Frame Capture
  useEffect(() => {
    let interval: any;
    if (isConnected && cameraStreamRef.current) {
      interval = setInterval(() => {
        if (videoRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
          const canvas = document.createElement('canvas');
          canvas.width = 480;
          canvas.height = 360;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
            const base64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
            wsRef.current.send(JSON.stringify({
              realtimeInput: { mediaChunks: [{ mimeType: 'image/jpeg', data: base64 }] }
            }));
          }
        }
      }, 1000); // 1fps for faster vision
    }
    return () => clearInterval(interval);
  }, [isConnected, !!cameraStreamRef.current]);

  // --- AI & Analysis ---

  const connect = useCallback(() => {
    if (!user) return;
    
    // Resume audio context immediately on user click
    if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume();
    }

    const ws = new WebSocket(`ws://localhost:4002?userId=${user.id}`);
    wsRef.current = ws;
    ws.onopen = () => {
        setIsConnected(true);
        console.log("Connected to StyleSense AI Engine");
    };
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.text) setMessages(prev => [...prev, { role: 'ai', text: data.text }]);
      if (data.audio) {
        // Log to verify audio data arrival
        if (messages.length % 10 === 0) console.log("Receiving audio stream...");
        playPCMChunk(data.audio);
      }
      if (data.toolCallResult) {
        const { name, result } = data.toolCallResult;
        if (name === 'update_style_insights') setInsights(result);
        if (name === 'generate_style_batch') setStyleGallery(result.suggestions);
      }
    };
  }, [user, messages.length]);

  const analyzeNow = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    if (audioContextRef.current?.state === 'suspended') {
        audioContextRef.current.resume();
    }

    let analysisCommand = `STRICTLY analyze my current look for ONLY the goal "${preferences}". FORGET all previous styles. Start by acknowledging that you see me.`;
    
    if (inspirationImg) {
      analysisCommand += " Tailor everything specifically based on my Inspiration image aesthetic.";
    }

    if (!cameraStreamRef.current && currentLookImg) {
      analysisCommand += " Reference my uploaded Current Look photo.";
    } else if (cameraStreamRef.current) {
      analysisCommand += " Use my live camera feed to see what I'm wearing right now.";
    }

    wsRef.current.send(JSON.stringify({ text: analysisCommand }));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'inspiration' | 'current_look') => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        if (type === 'current_look') setCurrentLookImg(base64);
        else setInspirationImg(base64);
        
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            text: `[User uploaded ${type.replace('_', ' ')}]`,
            realtimeInput: { mediaChunks: [{ mimeType: file.type, data: base64.split(',')[1] }] }
          }));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleLike = (item: StyleItem) => {
    const albumKey = preferences || 'Uncategorized';
    setCloset(prev => {
      const updatedAlbum = [...(prev[albumKey] || []), item];
      const newCloset = { ...prev, [albumKey]: updatedAlbum };
      localStorage.setItem('styleSenseClosetAlbums', JSON.stringify(newCloset));
      return newCloset;
    });
    setMessages(prev => [...prev, { role: 'system', text: `Added to your ${albumKey} album.` }]);
  };

  // --- Auth ---

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
        const res = await fetch('http://localhost:3001/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: authEmail, password: authPassword })
        });
        const data = await res.json();
        if (res.ok) {
            setUser(data);
            localStorage.setItem('styleSenseUser', JSON.stringify(data));
        } else { setAuthError(data.error); }
    } catch (err) { setAuthError('Connection failed'); console.error(err); }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <div className="w-full max-w-md premium-card p-10">
          <div className="text-center mb-10">
            <div className="w-16 h-16 bg-black rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-lg"><Shirt className="text-white w-8 h-8" /></div>
            <h1 className="text-3xl font-bold tracking-tight">Style_it</h1>
            <p className="text-neutral-500 text-sm mt-2 font-medium">Elevate your aesthetic journey.</p>
          </div>
          <form onSubmit={handleAuth} className="space-y-4">
            <input type="email" placeholder="Email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} className="w-full bg-neutral-50 border border-neutral-100 rounded-2xl py-4 px-6 outline-none focus:border-black transition" />
            <input type="password" placeholder="Password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} className="w-full bg-neutral-50 border border-neutral-100 rounded-2xl py-4 px-6 outline-none focus:border-black transition" />
            {authError && <p className="text-red-500 text-xs text-center font-bold">{authError}</p>}
            <button type="submit" className="w-full btn-premium btn-primary justify-center py-4">Sign In</button>
          </form>
        </div>
      </div>
    );
  }

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280, height: 720 } });
      cameraStreamRef.current = stream;
      // We use a small timeout to ensure the DOM element is rendered before attaching the stream
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(console.error);
        }
      }, 100);
      setMessages(prev => [...prev]); 
    } catch (err) {
      console.error("Camera access denied:", err);
    }
  };

  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
    cameraStreamRef.current = null;
    // Force re-render
    setMessages(prev => [...prev]);
  };

  const clearInsights = () => {
    setMessages([]);
    setInsights({ suggestions: 'Waiting...' });
    setStyleGallery([]);
  };

  return (
    <div className="flex h-screen bg-white overflow-hidden text-neutral-900">
      
      {/* SIDEBAR */}
      <aside className="w-[280px] bg-[#f8f9fa] border-r border-[#e9ecef] flex flex-col p-6 shrink-0">
        <div className="flex items-center gap-3 mb-10 px-2">
          <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center"><Shirt className="text-white w-5 h-5" /></div>
          <span className="font-bold text-lg">Style_it</span>
        </div>

        <nav className="flex flex-col gap-1 mb-10">
          <button onClick={() => setActiveTab('live')} className={`nav-link ${activeTab === 'live' ? 'active' : ''}`}><Camera className="w-5 h-5" /> Live Session</button>
          <button onClick={() => setActiveTab('closet')} className={`nav-link ${activeTab === 'closet' ? 'active' : ''}`}><ShoppingBag className="w-5 h-5" /> My Closet</button>
          <button onClick={() => setActiveTab('trends')} className={`nav-link ${activeTab === 'trends' ? 'active' : ''}`}><TrendingUp className="w-5 h-5" /> Style Trends</button>
          <button onClick={() => setActiveTab('settings')} className={`nav-link ${activeTab === 'settings' ? 'active' : ''}`}><Settings className="w-5 h-5" /> Settings</button>
        </nav>

        {activeTab === 'live' && (
          <div className="mb-6 px-2">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[11px] font-bold text-neutral-400 uppercase tracking-widest">Sessions</span>
              <button onClick={() => createNewSession()} className="p-1 hover:bg-white rounded-md transition"><PlusCircle className="w-4 h-4 text-neutral-400" /></button>
            </div>
            <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto">
              {sessions.map(s => (
                <button key={s.id} onClick={() => loadSession(s)} className={`text-left text-xs px-3 py-2 rounded-lg transition ${currentSessionId === s.id ? 'bg-white shadow-sm font-semibold' : 'text-neutral-500 hover:text-black'}`}>{s.name}</button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-auto pt-6 border-t border-[#e9ecef] flex items-center gap-3">
          <div className="w-10 h-10 bg-neutral-200 rounded-full flex items-center justify-center font-bold">{user.email[0].toUpperCase()}</div>
          <div className="flex-1 overflow-hidden">
            <p className="text-sm font-semibold truncate">{user.email.split('@')[0]}</p>
            <p className="text-[10px] text-neutral-500 uppercase font-bold tracking-widest">Premium</p>
          </div>
          <button onClick={() => setUser(null)} className="p-2 hover:bg-neutral-200 rounded-lg text-neutral-400"><LogOut className="w-4 h-4" /></button>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col overflow-y-auto bg-white relative">
        
        {activeTab === 'live' && (
          <>
            <header className="px-10 py-6 border-b border-[#e9ecef] flex flex-col gap-4 bg-white/90 backdrop-blur-md sticky top-0 z-20">
              <div className="flex items-center justify-between gap-6">
                <div className="flex-1 max-w-2xl flex items-center gap-4">
                  <span className="text-sm font-bold text-neutral-400">Target Style</span>
                  <input 
                    type="text" 
                    value={tempPreferences} 
                    onChange={e => setTempPreferences(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleStyleSubmit()}
                    placeholder="Describe your aesthetic... (Press Enter to set)" 
                    className="flex-1 bg-neutral-50 border border-neutral-100 rounded-2xl py-3.5 px-6 outline-none focus:border-black transition font-semibold"
                  />
                </div>
                <div className="flex items-center gap-4">
                  <button onClick={connect} disabled={isConnected} className={`btn-premium ${isConnected ? 'bg-green-50 text-green-600 border-green-100' : 'btn-secondary'}`}>{isConnected ? 'Connected' : 'Connect AI'}</button>
                  <button onClick={analyzeNow} className="btn-premium btn-primary"><Sparkles className="w-4 h-4" /> Analyze Now</button>
                </div>
              </div>
            </header>

            <div className="px-10 py-8 max-w-5xl mx-auto w-full space-y-10 animate-fade-in">
              <section className="grid grid-cols-2 gap-6">
                <div className="upload-zone aspect-video flex flex-col items-center justify-center relative overflow-hidden group">
                  {cameraStreamRef.current ? (
                    <div className="w-full h-full relative">
                      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover transform scale-x-[-1]" />
                      <button onClick={stopCamera} className="absolute top-4 right-4 p-2.5 bg-black/40 backdrop-blur-md rounded-full text-white hover:bg-black/60 transition shadow-lg"><X className="w-4 h-4" /></button>
                    </div>
                  ) : currentLookImg ? (
                    <div className="w-full h-full relative">
                      <img src={currentLookImg} alt="Look" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-3">
                         <button onClick={() => currentLookInputRef.current?.click()} title="Change Photo" className="p-3 bg-white rounded-full text-black hover:scale-110 transition"><ImageIcon className="w-5 h-5" /></button>
                         <button onClick={startCamera} title="Use Camera" className="p-3 bg-white rounded-full text-black hover:scale-110 transition"><Camera className="w-5 h-5" /></button>
                         <button onClick={() => setCurrentLookImg(null)} title="Clear Image" className="p-3 bg-white rounded-full text-red-500 hover:scale-110 transition"><Trash2 className="w-5 h-5" /></button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center flex flex-col items-center gap-4 p-6">
                      <div className="flex gap-4">
                        <button onClick={() => currentLookInputRef.current?.click()} className="flex flex-col items-center gap-2 p-4 rounded-2xl border border-neutral-100 hover:bg-neutral-50 transition">
                          <ImageIcon className="w-6 h-6 text-neutral-400" />
                          <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Upload Photo</span>
                        </button>
                        <button onClick={startCamera} className="flex flex-col items-center gap-2 p-4 rounded-2xl border border-neutral-100 hover:bg-neutral-50 transition">
                          <Camera className="w-6 h-6 text-neutral-400" />
                          <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Use Camera</span>
                        </button>
                      </div>
                      <p className="text-[11px] font-medium text-neutral-400">Current Outfit Reference</p>
                    </div>
                  )}
                  <input type="file" ref={currentLookInputRef} hidden onChange={e => handleFileUpload(e, 'current_look')} />
                </div>

                <div className="upload-zone aspect-video flex flex-col items-center justify-center relative overflow-hidden group">
                  {inspirationImg ? (
                    <div className="w-full h-full relative">
                      <img src={inspirationImg} alt="Inspiration" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-3">
                         <button onClick={() => inspirationInputRef.current?.click()} title="Change Photo" className="p-3 bg-white rounded-full text-black hover:scale-110 transition"><RefreshCw className="w-5 h-5" /></button>
                         <button onClick={() => setInspirationImg(null)} title="Clear Image" className="p-3 bg-white rounded-full text-red-500 hover:scale-110 transition"><Trash2 className="w-5 h-5" /></button>
                      </div>
                    </div>
                  ) : (
                    <div onClick={() => inspirationInputRef.current?.click()} className="text-center cursor-pointer p-6 hover:bg-neutral-50 transition rounded-3xl w-full h-full flex flex-col items-center justify-center gap-2">
                      <LayoutGrid className="w-8 h-8 text-neutral-300 mx-auto" />
                      <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Inspiration Image</p>
                    </div>
                  )}
                  <input type="file" ref={inspirationInputRef} hidden onChange={e => handleFileUpload(e, 'inspiration')} />
                </div>
              </section>

              <section className="space-y-6 pb-20">
                <h2 className="text-xl font-bold tracking-tight">Discovery</h2>
                <div className="grid grid-cols-3 gap-6">
                  {styleGallery.length > 0 ? styleGallery.map((item, i) => (
                    <div key={i} className="premium-card p-6 flex flex-col gap-4">
                      <div className="flex-1">
                        <h4 className="font-bold text-sm mb-1">{item.name}</h4>
                        <p className="text-[11px] text-neutral-500 leading-relaxed line-clamp-3 mb-2">{item.reason}</p>
                        {item.retailers && item.retailers.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {item.retailers.map((r, ri) => (
                              <button 
                                key={ri} 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(`https://www.google.com/search?q=${encodeURIComponent(item.name + ' ' + r)}`, '_blank');
                                }}
                                className="text-[9px] bg-neutral-50 border border-neutral-100 px-2 py-0.5 rounded-full font-bold text-neutral-500 uppercase tracking-tighter flex items-center gap-1.5 hover:bg-neutral-100 hover:border-neutral-200 transition"
                              >
                                <ShoppingBag className="w-2.5 h-2.5 text-neutral-400" />
                                {r}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => handleLike(item)} className="p-3 bg-neutral-50 hover:bg-neutral-100 rounded-xl transition text-neutral-400 hover:text-red-500"><Heart className="w-4 h-4" /></button>
                        <button 
                          onClick={() => window.open(item.shop_url || `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(item.name)}`, '_blank')} 
                          className="flex-1 btn-premium btn-primary justify-center text-[11px] py-2.5 font-bold uppercase tracking-widest gap-2"
                        >
                          <ShoppingBag className="w-3.5 h-3.5" />
                          Google Shop
                        </button>
                      </div>
                    </div>
                  )) : <div className="col-span-3 py-20 text-center text-neutral-400 italic">Generate insights to see recommendations...</div>}
                </div>
              </section>
            </div>
          </>
        )}

        {activeTab === 'closet' && (
          <div className="p-10 max-w-6xl mx-auto w-full animate-fade-in">
            <h1 className="text-3xl font-bold mb-10">My Closet</h1>
            <div className="space-y-12">
              {Object.keys(closet).length > 0 ? Object.entries(closet).map(([album, items]) => (
                <section key={album}>
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="font-bold text-lg flex items-center gap-2 text-neutral-900 border-l-4 border-black pl-4 uppercase tracking-widest text-sm">{album}</h3>
                    <span className="text-xs font-bold text-neutral-400">{items.length} items</span>
                  </div>
                  <div className="grid grid-cols-4 gap-6">
                    {items.map((item, idx) => (
                      <div key={idx} className="premium-card group">
                        <div className="p-8 text-center bg-neutral-50 rounded-t-3xl border-b border-neutral-100">
                           <Shirt className="w-8 h-8 text-neutral-200 mx-auto" />
                        </div>
                        <div className="p-4">
                          <p className="font-bold text-xs truncate">{item.name}</p>
                          <button onClick={() => window.open(`https://www.google.com/search?q=${encodeURIComponent(item.name)}&tbm=shop`, '_blank')} className="text-[10px] font-bold text-neutral-400 hover:text-black mt-2 flex items-center gap-1">GO TO SHOP <ExternalLink className="w-3 h-3" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )) : <div className="py-40 text-center text-neutral-400">No items in your closet yet. Like recommendations to save them here!</div>}
            </div>
          </div>
        )}

        {activeTab === 'trends' && (
          <div className="p-10 max-w-3xl mx-auto w-full animate-fade-in">
            <h1 className="text-3xl font-bold mb-2">Style Trends</h1>
            <p className="text-neutral-500 mb-10 font-medium">Global fashion insights</p>
            <div className="space-y-0">
              {loadingTrends ? (
                <div className="py-20 text-center text-neutral-400">Loading live trends...</div>
              ) : trends.length > 0 ? trends.map((t, i) => (
                <div key={i} className="trend-card group cursor-pointer hover:bg-neutral-50 -mx-6 px-6 transition">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">{t.source} • {t.time}</span>
                    <span className="text-[10px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">{t.trend}</span>
                  </div>
                  <h3 className="text-lg font-bold group-hover:underline">{t.title}</h3>
                  <div className="mt-4 flex gap-4">
                    <button onClick={() => window.open(t.url, '_blank')} className="text-[11px] font-bold flex items-center gap-1.5 text-neutral-400 hover:text-black transition"><Globe className="w-3 h-3" /> View News</button>
                    <button onClick={() => setPreferences(t.title)} className="text-[11px] font-bold flex items-center gap-1.5 text-neutral-400 hover:text-black transition"><TrendingUp className="w-3 h-3" /> Analyze Impact</button>
                  </div>
                </div>
              )) : (
                <div className="py-20 text-center text-neutral-400">No trends available right now.</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="p-10 max-w-3xl mx-auto w-full animate-fade-in">
            <h1 className="text-3xl font-bold mb-10">Settings</h1>
            <div className="space-y-8">
              <section className="premium-card p-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-neutral-900 rounded-full flex items-center justify-center font-bold text-white text-lg">{user.email[0].toUpperCase()}</div>
                  <div><p className="font-bold">{user.email}</p><p className="text-xs text-neutral-500">Premium Stylist Member</p></div>
                </div>
                <button className="btn-premium btn-secondary text-xs">Edit Profile</button>
              </section>
              <section className="space-y-4">
                <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-widest px-2">Preferences</h3>
                <div className="premium-card overflow-hidden">
                  <div onClick={() => setNotifications(!notifications)} className="p-4 border-b border-neutral-100 flex items-center justify-between hover:bg-neutral-50 cursor-pointer">
                    <div className="flex items-center gap-3"><Bell className="w-4 h-4" /><span className="text-sm font-medium">Notifications</span></div>
                    <div className={`w-10 h-5 rounded-full transition-colors flex items-center px-1 ${notifications ? 'bg-black' : 'bg-neutral-200'}`}>
                      <div className={`w-3 h-3 bg-white rounded-full transition-transform ${notifications ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                  </div>
                  <div onClick={() => setPrivacy(!privacy)} className="p-4 border-b border-neutral-100 flex items-center justify-between hover:bg-neutral-50 cursor-pointer">
                    <div className="flex items-center gap-3"><Shield className="w-4 h-4" /><span className="text-sm font-medium">Privacy & Security Mode</span></div>
                    <div className={`w-10 h-5 rounded-full transition-colors flex items-center px-1 ${privacy ? 'bg-black' : 'bg-neutral-200'}`}>
                      <div className={`w-3 h-3 bg-white rounded-full transition-transform ${privacy ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                  </div>
                  <div onClick={() => { localStorage.clear(); window.location.reload(); }} className="p-4 flex items-center justify-between hover:bg-red-50 cursor-pointer text-red-500">
                    <div className="flex items-center gap-3"><Trash2 className="w-4 h-4" /><span className="text-sm font-medium">Clear Usage History</span></div>
                  </div>
                </div>
              </section>
              <button onClick={() => setUser(null)} className="w-full btn-premium btn-secondary border-red-100 text-red-500 hover:bg-red-50 justify-center">Logout Session</button>
            </div>
          </div>
        )}

        {showSavePrompt && (
          <div className="fixed inset-0 z-[100] bg-black/20 backdrop-blur-sm flex items-center justify-center p-6">
            <div className="w-full max-sm premium-card p-8 animate-fade-in">
              <h3 className="font-bold text-lg mb-2">Save current session?</h3>
              <p className="text-sm text-neutral-500 mb-6 leading-relaxed">You're switching styles. Would you like to save your current progress as a new session?</p>
              <div className="flex flex-col gap-2">
                <button onClick={confirmNewSession} className="btn-premium btn-primary justify-center">Save & Switch</button>
                <button onClick={() => { setPreferences(pendingStyle || ''); setShowSavePrompt(false); setPendingStyle(null); }} className="btn-premium btn-secondary justify-center">Discard & Switch</button>
                <button onClick={() => { setShowSavePrompt(false); setPendingStyle(null); }} className="text-xs font-bold text-neutral-400 mt-2 py-2">Cancel</button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* RIGHT PANEL (INSIGHTS) */}
      <aside className="w-[350px] bg-[#f8f9fa] border-l border-[#e9ecef] flex flex-col shrink-0">
        <header className="p-6 border-b border-[#e9ecef] flex items-center justify-between gap-4">
           <div className="flex flex-1 gap-2">
            <button onClick={() => setRightPanelTab('insights')} className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-xl transition ${rightPanelTab === 'insights' ? 'bg-black text-white' : 'text-neutral-400 hover:text-black'}`}>Insights</button>
            <button onClick={() => setRightPanelTab('report')} className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-xl transition ${rightPanelTab === 'report' ? 'bg-black text-white' : 'text-neutral-400 hover:text-black'}`}>Report</button>
           </div>
           <button onClick={clearInsights} title="Clear Insights" className="p-2 hover:bg-neutral-200 rounded-lg text-neutral-400 transition"><RefreshCw className="w-4 h-4" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          {rightPanelTab === 'insights' ? (
            <>
              <section>
                <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-widest mb-4">Feedback</h3>
                <div className="bg-white premium-card p-5 text-sm leading-relaxed text-neutral-700">{insights.summary || 'Waiting for style input...'}</div>
              </section>
              {insights.top_tip && (
                <section>
                  <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-widest mb-4">Pro Tip</h3>
                  <div className="bg-black text-white rounded-3xl p-5 text-sm italic">"{insights.top_tip}"</div>
                </section>
              )}
              <section className="flex-1 flex flex-col min-h-[300px]">
                <h3 className="text-[11px] font-bold text-neutral-400 uppercase tracking-widest mb-4">Transcript</h3>
                <div className="bg-white premium-card flex-1 flex flex-col overflow-hidden">
                  <div className="flex-1 p-4 overflow-y-auto space-y-4 text-[11px]">
                    {messages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === 'ai' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[85%] p-3 rounded-2xl ${m.role === 'ai' ? 'bg-neutral-50 text-neutral-600' : 'bg-black text-white'}`}>{m.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </>
          ) : (
            <div className="space-y-6 animate-fade-in">
              <section className="premium-card p-6 space-y-4">
                <h4 className="text-xs font-bold uppercase tracking-widest text-neutral-400">Analysis Summary</h4>
                <p className="text-xs leading-relaxed text-neutral-600">{insights.recommendations || 'Full report will appear here after analysis.'}</p>
                <div className="pt-4 border-t border-neutral-50 flex flex-col gap-2">
                  <div className="flex justify-between text-[10px] font-bold"><span>Cohesion</span><span className="text-neutral-400">85%</span></div>
                  <div className="w-full h-1 bg-neutral-50 rounded-full overflow-hidden"><div className="w-[85%] h-full bg-black" /></div>
                </div>
              </section>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};

export default App;
