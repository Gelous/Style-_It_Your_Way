import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, Modality } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ port: 4002 });

// Persistence Configuration
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'siyw';
let storage: Storage | null = null;
try { storage = new Storage(); } catch (e) {}

// Helper to save data (Scoped by User)
async function saveToPersistence(userId: string, fileName: string, data: any) {
  const cloudPath = `${userId}/${fileName}`;
  try {
    if (storage) {
        await storage.bucket(BUCKET_NAME).file(cloudPath).save(JSON.stringify(data, null, 2));
        return;
    }
  } catch (err) {}
  
  // Local Fallback
  const userDir = path.join(process.cwd(), 'data', userId);
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(path.join(userDir, fileName), JSON.stringify(data, null, 2));
}

// Helper to load data (Scoped by User)
async function loadFromPersistence(userId: string, fileName: string, defaultValue: any) {
  const cloudPath = `${userId}/${fileName}`;
  try {
    if (storage) {
        const [exists] = await storage.bucket(BUCKET_NAME).file(cloudPath).exists();
        if (exists) {
            const [content] = await storage.bucket(BUCKET_NAME).file(cloudPath).download();
            return JSON.parse(content.toString());
        }
    }
  } catch (err) {}

  // Local Fallback
  const localPath = path.join(process.cwd(), 'data', userId, fileName);
  try {
    const content = await fs.readFile(localPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) { return defaultValue; }
}

// User Database (Local JSON)
const USERS_FILE = path.join(process.cwd(), 'local_users.json');
async function getUsers() {
    try {
        const content = await fs.readFile(USERS_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (e) { return []; }
}
async function saveUsers(users: any[]) {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// Auth Endpoints
app.post('/api/signup', async (req, res) => {
    const { email, password } = req.body;
    const users = await getUsers();
    if (users.find((u: any) => u.email === email)) return res.status(400).json({ error: 'User exists' });
    
    const newUser = { id: 'user_' + Date.now(), email, password };
    users.push(newUser);
    await saveUsers(users);
    res.json({ id: newUser.id, email: newUser.email });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const users = await getUsers();
    const user = users.find((u: any) => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ id: user.id, email: user.email });
});

app.get('/', (req, res) => res.send('StyleSense AI Engine is running.'));

// Global AI Setup
const ai = new GoogleGenAI({ 
    apiKey: process.env.GOOGLE_API_KEY!,
    httpOptions: { apiVersion: 'v1beta' }
});

const SYSTEM_INSTRUCTION = `
You are StyleSense AI, a world-class Visual Style Transition Coach.

CORE RULES:
- VISION ENABLED: You can see the user through their camera feed. Constantly analyze their current outfit, posture, and surroundings.
- VISUAL FEEDBACK: Start by describing what you see. ("I see you're wearing a navy blazer...")
- STYLE TRANSITION: Guide the user from their current look to their "Target Aesthetic".
- VISUAL FOCUS: You must provide 6 real-world style options using 'generate_style_batch'.
- IMAGE SELECTION: Your 'imageUrl' MUST be a high-quality, direct fashion image link.
- GOOGLE SEARCH: Use search to find the latest trends and store availability.
- INTERACTIVE: Be encouraging, observant, and proactive. If the user moves or changes something, acknowledge it.
- PERSONALIZED: Use the specific user's Style Profile provided below.
`;

const toolsList = [
  { 
    googleSearch: {},
    functionDeclarations: [
      {
        name: 'update_style_insights',
        description: 'Updates the summary report.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            suggestions: { type: Type.STRING },
            improvements: { type: Type.STRING },
            recommendations: { type: Type.STRING }
          },
          required: ['suggestions', 'improvements', 'recommendations']
        }
      },
      {
        name: 'generate_style_batch',
        description: 'Generates a batch of 6 styles with verified images.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            options: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  retailers: { type: Type.ARRAY, items: { type: Type.STRING } },
                  imageUrl: { type: Type.STRING },
                  style_keyword: { type: Type.STRING, description: 'Keywords to find this style on Unsplash if link fails (e.g. "minimalist beige coat")' }
                },
                required: ['name', 'reason', 'retailers', 'imageUrl', 'style_keyword']
              }
            }
          },
          required: ['options']
        }
      },
      {
        name: 'add_to_closet',
        description: 'Adds item to closet.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            description: { type: Type.STRING },
            imageUrl: { type: Type.STRING },
            retailers: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ['name', 'description', 'imageUrl', 'retailers']
        }
      }
    ]
  }
];

wss.on('connection', async (ws: WebSocket, request) => {
  // Extract userId from URL query params
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const userId = url.searchParams.get('userId');

  if (!userId) {
      console.log('Rejected: No userId provided');
      ws.close();
      return;
  }

  console.log(`--- CLIENT CONNECTED (${userId}) ---`);

  // Load User Data
  let myPreferences = (await loadFromPersistence(userId, 'preferences.json', { preferences: '' })).preferences;
  let myCloset = await loadFromPersistence(userId, 'closet.json', []);
  
  ws.send(JSON.stringify({ toolCallResult: { name: 'get_closet', result: { items: myCloset } } }));

  let session: any;

  // Tool Handlers (now closure-scoped to user)
  const toolHandlers: Record<string, Function> = {
    update_style_insights: async (args: any) => args,
    generate_style_batch: async (args: any) => {
        const suggestions = args.options.map((opt: any) => {
            let finalUrl = opt.imageUrl;
            // Detect placeholder or invalid URLs
            const isPlaceholder = !finalUrl || 
                                finalUrl.includes('example.com') || 
                                finalUrl.length < 15 || 
                                !finalUrl.startsWith('http');
            
            if (isPlaceholder) {
                // Use a dynamic fallback based on the keyword provided by the AI
                const keyword = encodeURIComponent(opt.style_keyword || opt.name || 'fashion');
                // Construct a URL that uses Unsplash search keywords
                finalUrl = `https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?q=80&w=800&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&fashion=${keyword}`;
                
                // If we don't even have a keyword, use a random one from our pool
                if (!opt.style_keyword) {
                   const fallbacks = [
                    '1515886657613-9f3515b0c78f', '1434389677669-e08b4cac3105', '1591047139829-d91aecb6caea',
                    '1552374196-1ab2a1c593e8', '1594938298603-c8148c4dae35', '1539109136881-3be0616bc469'
                   ];
                   finalUrl = `https://images.unsplash.com/photo-${fallbacks[Math.floor(Math.random() * fallbacks.length)]}?q=80&w=800&auto=format`;
                }
            }
            return { ...opt, imageUrl: finalUrl };
        });
        return { suggestions };
    },
    add_to_closet: async (args: any) => {
        const newItem = { id: String(Date.now()), ...args };
        myCloset.push(newItem);
        await saveToPersistence(userId, 'closet.json', myCloset);
        return { success: true, item: newItem };
    }
  };

  try {
    session = await ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-latest',
      config: {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION + (myPreferences ? `\n\nUSER TARGET STYLE PROFILE: ${myPreferences}` : "") }] },
        tools: toolsList,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        responseModalities: [Modality.AUDIO]
      },
      callbacks: {
        onopen: () => {
            console.log(`--- Gemini Connected for ${userId} ---`);
            setTimeout(() => {
                if (session) {
                    session.sendClientContent({ 
                        turns: [{ role: 'user', parts: [{ text: "Coach, show me a visual gallery of 6 real-world style options for my Target Goal." }] }], 
                        turnComplete: true 
                    });
                }
            }, 1000);
        },
        onmessage: async (message: any) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (message.serverContent?.modelTurn) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.text) ws.send(JSON.stringify({ text: part.text }));
              if (part.inlineData) ws.send(JSON.stringify({ audio: part.inlineData.data }));
            }
          }
          if (message.toolCall) {
            const functionResponses = [];
            for (const call of message.toolCall.functionCalls) {
              const toolFunc = toolHandlers[call.name];
              if (toolFunc) {
                const result = await toolFunc(call.args);
                ws.send(JSON.stringify({ toolCallResult: { name: call.name, result } }));
                functionResponses.push({ id: call.id, name: call.name, response: result });
              }
            }
            if (functionResponses.length > 0) session.sendToolResponse({ functionResponses });
          }
        },
        onerror: (error: any) => console.error('!!! Gemini Error:', error),
        onclose: (event: any) => {
          console.log(`--- Gemini Closed for ${userId} --- Code:`, event.code);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        }
      }
    });
  } catch (err) {
    console.error("Failed to connect:", err);
    ws.close();
    return;
  }

  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.realtimeInput) {
        if (data.realtimeInput.audio) {
            session.sendRealtimeInput({ audio: data.realtimeInput.audio });
        } else if (data.realtimeInput.video) {
            session.sendRealtimeInput({ video: data.realtimeInput.video });
        } else if (data.realtimeInput.mediaChunks) {
            for (const chunk of data.realtimeInput.mediaChunks) {
                if (chunk.mimeType.includes('audio')) session.sendRealtimeInput({ audio: chunk });
                else session.sendRealtimeInput({ video: chunk });
            }
        }
      } else if (data.text) {
        // Special case: Update Goal command
        if (data.text.startsWith("Update Goal: ")) {
            myPreferences = data.text.replace("Update Goal: ", "");
            await saveToPersistence(userId, 'preferences.json', { preferences: myPreferences });
            session.sendClientContent({ 
                turns: [{ role: 'user', parts: [{ text: `CRITICAL INSTRUCTION: My Target Aesthetic has been CHANGED to: "${myPreferences}". FORGET all previous goals. Strictly follow this NEW goal for all future recommendations and visual gallery updates. Acknowledge this change now and update your style batch immediately.` }] }], 
                turnComplete: true 
            });
        } else {
            session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: data.text }] }], turnComplete: true });
        }
      }
    } catch (e) { console.error('WS Message Error:', e); }
  });

  ws.on('close', () => {
    console.log(`Client disconnected (${userId})`);
    session?.close();
  });
});

app.listen(3001, () => console.log('HTTP Server listening on port 3001'));
console.log(`StyleSense AI Engine listening on port 4002`);
