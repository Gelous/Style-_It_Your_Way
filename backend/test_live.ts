import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({path: 'backend/.env'});

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY,
});

async function run() {
    try {
        console.log("Connecting...", process.env.GOOGLE_API_KEY ? "key ok" : "no key");
        const session = await ai.live.connect({
            model: 'gemini-2.0-flash-exp',
            config: {
                tools: [{ googleSearch: {} }]
            }
        });
        console.log("Connected!");
        session.close();
    } catch(e: any) {
        console.error("Error:", e);
    }
}
run();
