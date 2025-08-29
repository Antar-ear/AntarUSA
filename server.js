// Antar US MVP server (Azure STT + Translator, no TTS)
// CommonJS build. Node 18+

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const compression = require('compression');
const helmet = require('helmet');
require('dotenv').config();

// Azure helpers
const { transcribeOnce } = require('./speech/azure_speech');
const { translateText } = require('./speech/azure_translate');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Multer (not used in MVP but available for file-based tests)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// In-memory room/user tracking
const activeRooms = new Map(); // roomId -> { hotelName, createdAt, users:Set, guestLanguage }
const userRoles = new Map();   // socket.id -> { room, role, language }

const languageNames = {
  'hi-IN': 'Hindi',
  'bn-IN': 'Bengali',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'mr-IN': 'Marathi',
  'gu-IN': 'Gujarati',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'pa-IN': 'Punjabi',
  'or-IN': 'Odia',
  'od-IN': 'Odia',
  'es-ES': 'Spanish',
  'de-DE': 'German',
  'fr-FR': 'French',
  'en-IN': 'English (India)',
  'en-US': 'English (US)'
};

function getGuestLanguageInRoom(room) {
  const roomData = activeRooms.get(room);
  if (!roomData) return 'hi-IN';
  if (roomData.guestLanguage) return roomData.guestLanguage;

  for (const userId of roomData.users) {
    const info = userRoles.get(userId);
    if (info && info.role === 'guest') return info.language || 'hi-IN';
  }
  return 'hi-IN';
}

// Routes
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (_req, res) => {
  const hasSpeech = !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
  const hasTrans = !!(process.env.AZURE_TRANSLATOR_KEY && process.env.AZURE_TRANSLATOR_REGION);
  res.json({
    status: 'ok',
    azureSpeech: hasSpeech,
    azureTranslator: hasTrans,
    timestamp: new Date().toISOString()
  });
});

// TTS disabled for MVP
app.post('/api/tts', (_req, res) => {
  res.status(501).json({ error: 'TTS disabled for MVP' });
});

// Generate room
app.post('/api/generate-room', (req, res) => {
  const hotelName = (req.body?.hotelName || 'Unknown Hotel').toString();
  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  activeRooms.set(roomId, {
    hotelName,
    createdAt: new Date(),
    users: new Set(),
    guestLanguage: null
  });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const guestUrl = `${baseUrl}?room=${roomId}`;

  res.json({ roomId, guestUrl, qrData: guestUrl });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', (data = {}) => {
    const { room, role, language = 'hi-IN' } = data;

    // leave previous
    const prev = userRoles.get(socket.id)?.room;
    if (prev) {
      socket.leave(prev);
      const pd = activeRooms.get(prev);
      if (pd) pd.users.delete(socket.id);
    }

    socket.join(room);
    const userLanguage = role === 'receptionist' ? 'en-US' : language;
    userRoles.set(socket.id, { room, role, language: userLanguage });

    if (!activeRooms.has(room)) {
      activeRooms.set(room, {
        hotelName: 'Unknown Hotel',
        createdAt: new Date(),
        users: new Set(),
        guestLanguage: null
      });
    }
    const rd = activeRooms.get(room);
    rd.users.add(socket.id);
    if (role === 'guest') rd.guestLanguage = userLanguage;

    console.log(`Join: ${socket.id} -> room=${room}, role=${role}, lang=${userLanguage}`);

    socket.emit('room_joined', {
      room, role, language: languageNames[userLanguage] || userLanguage
    });
    socket.to(room).emit('user_joined', {
      role, language: languageNames[userLanguage] || userLanguage, userId: socket.id
    });
    io.to(room).emit('room_stats', {
      userCount: rd.users.size, hotelName: rd.hotelName, guestLanguage: rd.guestLanguage
    });
  });

  socket.on('audio_message', async (data = {}) => {
    try {
      const { room, role, language, audioData } = data;
      const info = userRoles.get(socket.id);
      if (!info || info.room !== room) {
        socket.emit('error', { message: 'Not authorized for this room' });
        return;
      }

      io.to(room).emit('processing_status', { status: 'transcribing', speaker: role });

      const audioBuffer = Buffer.from(audioData || '', 'base64');
      // Azure STT (single-shot)
      const transcription = await transcribeOnce(audioBuffer, language || info.language);

      if (!transcription.transcript || !transcription.transcript.trim()) {
        io.to(room).emit('processing_status', { status: 'error', message: 'No speech detected' });
        return;
      }

      io.to(room).emit('processing_status', { status: 'translating', speaker: role });

      let sourceLanguage, targetLanguage;
      if (role === 'guest') {
        sourceLanguage = language || info.language;
        targetLanguage = 'en-US';
      } else {
        sourceLanguage = 'en-US';
        targetLanguage = getGuestLanguageInRoom(room);
      }

      const translation = await translateText(transcription.transcript, sourceLanguage, targetLanguage);

      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        timestamp: new Date().toISOString(),
        room,
        speaker: role,
        original: {
          text: transcription.transcript,
          language: sourceLanguage,
          languageName: languageNames[sourceLanguage] || sourceLanguage
        },
        translated: {
          text: translation.text,
          language: targetLanguage,
          languageName: languageNames[targetLanguage] || targetLanguage
        },
        confidence: transcription.confidence ?? 0.95,
        speakerId: socket.id,
        ttsAvailable: false
      };

      io.to(room).emit('translation', messageData);
      io.to(room).emit('processing_status', { status: 'complete' });
    } catch (err) {
      console.error('audio_message error:', err?.message || err);
      socket.emit('error', { message: 'Failed to process audio_message', error: err?.message });
      io.to(userRoles.get(socket.id)?.room || '').emit('processing_status', {
        status: 'error', message: err?.message
      });
    }
  });

  socket.on('text_message', async (data = {}) => {
    try {
      const { room, role, text, language } = data;
      const info = userRoles.get(socket.id);
      if (!info || info.room !== room) {
        socket.emit('error', { message: 'Not authorized for this room' });
        return;
      }
      io.to(room).emit('processing_status', { status: 'translating', speaker: role });

      let sourceLanguage, targetLanguage;
      if (role === 'guest') {
        sourceLanguage = language || info.language;
        targetLanguage = 'en-US';
      } else {
        sourceLanguage = 'en-US';
        targetLanguage = getGuestLanguageInRoom(room);
      }

      const translation = await translateText(text, sourceLanguage, targetLanguage);

      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        timestamp: new Date().toISOString(),
        room,
        speaker: role,
        original: { text, language: sourceLanguage, languageName: languageNames[sourceLanguage] || sourceLanguage },
        translated: { text: translation.text, language: targetLanguage, languageName: languageNames[targetLanguage] || targetLanguage },
        confidence: 1.0,
        speakerId: socket.id,
        ttsAvailable: false
      };

      io.to(room).emit('translation', messageData);
      io.to(room).emit('processing_status', { status: 'complete' });
    } catch (err) {
      console.error('text_message error:', err?.message || err);
      socket.emit('error', { message: 'Failed to process text_message', error: err?.message });
      io.to(userRoles.get(socket.id)?.room || '').emit('processing_status', { status: 'error', message: err?.message });
    }
  });

  socket.on('get_room_info', (data = {}) => {
    const rd = activeRooms.get(data.room);
    if (rd) {
      socket.emit('room_info', {
        hotelName: rd.hotelName,
        userCount: rd.users.size,
        createdAt: rd.createdAt,
        guestLanguage: rd.guestLanguage
      });
    }
  });

  socket.on('disconnect', () => {
    const info = userRoles.get(socket.id);
    if (!info) return;
    const { room, role } = info;
    const rd = activeRooms.get(room);
    if (rd) {
      rd.users.delete(socket.id);
      if (role === 'guest') rd.guestLanguage = null;
      socket.to(room).emit('user_left', { role, userId: socket.id });
      io.to(room).emit('room_stats', {
        userCount: rd.users.size, hotelName: rd.hotelName, guestLanguage: rd.guestLanguage
      });

      if (rd.users.size === 0) {
        setTimeout(() => {
          const rdx = activeRooms.get(room);
          if (rdx && rdx.users.size === 0) {
            activeRooms.delete(room);
            console.log('Cleaned empty room:', room);
          }
        }, 5 * 60 * 1000);
      }
    }
    userRoles.delete(socket.id);
  });

  socket.on('error', (e) => console.error('Socket error:', e));
});

// Error middleware
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Antar MVP server on :${PORT}`);
  console.log(`Open http://localhost:${PORT}`);
  if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
    console.warn('Azure Speech not configured.');
  }
  if (!process.env.AZURE_TRANSLATOR_KEY || !process.env.AZURE_TRANSLATOR_REGION) {
    console.warn('Azure Translator not configured.');
  }
});
