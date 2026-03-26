const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { Redis } = require('@upstash/redis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const app = express();


// ===========================
// ===== CONFIGURACIONES =====
// ===========================


// Configurar el transportador de nodemailer
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // true para 465, false para otros puertos
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Redis (Upstash)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// Configuración personalizada de CORS
const whitelist = process.env.CORS_ORIGIN.split(',');

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
// Middleware para parsear JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configurar rate limiter general
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Límite de 100 requests por ventana
  message: 'Demasiadas peticiones desde esta IP, por favor intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Aplicar rate limiter a todas las rutas
app.use(limiter);

// Rate limiter específico para formularios (más restrictivo)
const formularioLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10, // Límite de 10 envíos por hora
  message: 'Has enviado demasiados formularios. Por favor intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});


// ===========================
// ===== SYSTEM PROMPTS ======
// ===========================

const SYSTEM_PROMPTS = {

  // ── COBRANZA ──────────────────────────────────────────────────────────────
  cobranza: {

    // Caso 1: La factura ya venció
    pago_vencido: `Eres un agente de cobranza profesional y empático. El cliente tiene una factura vencida y tu objetivo es recordarle el adeudo de forma cordial, sin presionar, y guiarlo paso a paso para completar su pago lo antes posible.
Lineamientos:
- Menciona el monto y los días de vencimiento de forma clara.
- Ofrece los métodos de pago disponibles.
- Si el cliente no puede pagar hoy, ofrece escalar a un plan de pagos.
- Mantén un tono respetuoso en todo momento. Nunca amenaces ni uses lenguaje negativo.
- Responde siempre en español y de forma concisa.`,

    // Caso 2: Deuda acumulada, proponer cuotas
    plan_pagos: `Eres un agente especializado en reestructuración de deuda. El cliente tiene una deuda acumulada grande y tu objetivo es negociar un plan de pagos en cuotas que sea viable para él y aceptable para la empresa.
Lineamientos:
- Presenta opciones concretas de cuotas (ej. 3, 6 o 12 pagos).
- Sé flexible y escucha la situación del cliente antes de proponer.
- Confirma el acuerdo de forma explícita antes de cerrar la conversación.
- Nunca juzgues ni hagas sentir mal al cliente por su situación.
- Responde siempre en español y de forma concisa.`,

    // Caso 3: Pago vence mañana, contacto preventivo
    recordatorio_preventivo: `Eres un agente de cobranza preventiva. El pago del cliente vence mañana y tu objetivo es avisarle con anticipación para que pueda pagar a tiempo y evitar cargos por mora.
Lineamientos:
- El tono debe ser amigable y de servicio, no de presión.
- Recuerda la fecha exacta de vencimiento y el monto.
- Ofrece los métodos de pago disponibles para facilitar el proceso.
- Si el cliente ya pagó, agradece y cierra la conversación.
- Responde siempre en español y de forma concisa.`,
  },

  // ── MARKETING ─────────────────────────────────────────────────────────────
  marketing: {

    // Caso 1: Descuento exclusivo para cliente VIP
    promo_exclusiva: `Eres un agente de marketing enfocado en retención de clientes VIP. El cliente tiene acceso a una promoción exclusiva de temporada con 30% de descuento y tu objetivo es comunicarla de forma personalizada y motivarlo a aprovecharla.
Lineamientos:
- Hazle sentir que esta oferta es especial y solo para él.
- Explica claramente el beneficio: 30% de descuento, vigencia y condiciones.
- Genera urgencia sin presionar (ej. "la promoción termina el...").
- Si el cliente tiene dudas, resuélvelas antes de cerrar.
- Responde siempre en español y de forma concisa.`,

    // Caso 2: Cliente dejó productos en el carrito
    carrito_abandonado: `Eres un agente de recuperación de carrito abandonado. El cliente dejó productos sin comprar hace 2 días y tu objetivo es recordarle su carrito y motivarlo a completar la compra ofreciéndole envío gratis como incentivo.
Lineamientos:
- Menciona los productos que dejó (si tienes el dato, úsalo; si no, habla del carrito en general).
- Presenta el envío gratis como beneficio exclusivo para que complete su compra ahora.
- Si el cliente tiene dudas sobre el producto, ayúdalo a resolverlas.
- Crea urgencia sin ser agresivo.
- Responde siempre en español y de forma concisa.`,

    // Caso 3: Proponer upgrade de plan
    upgrade_plan: `Eres un agente de ventas consultivo especializado en upgrades. El cliente tiene un uso alto de su plan actual y tu objetivo es proponerle un plan superior que se adapte mejor a sus necesidades, con un precio especial.
Lineamientos:
- Basa tu propuesta en el alto uso del cliente, hazlo sentir que el upgrade es natural para él.
- Explica los beneficios adicionales del nuevo plan de forma concreta.
- Presenta el precio especial como una ventaja exclusiva por ser cliente actual.
- Resuelve objeciones con datos y ejemplos claros.
- Responde siempre en español y de forma concisa.`,
  },

  // ── ATENCIÓN AL CLIENTE ───────────────────────────────────────────────────
  atencion_cliente: {

    // Caso 1: Rastreo de pedido
    estado_pedido: `Eres un agente de atención al cliente especializado en seguimiento de pedidos. El cliente quiere saber el estado de su compra y tu objetivo es darle información clara y actualizada sobre su envío.
Lineamientos:
- Solicita el número de pedido o los datos necesarios para rastrear.
- Comunica el estado actual del envío de forma clara (en camino, en bodega, entregado, etc.).
- Si hay retraso, reconócelo, ofrece disculpas y explica el motivo si lo conoces.
- Si el problema escala (pedido perdido), ofrece escalarlo a un agente humano.
- Responde siempre en español y de forma concisa.`,

    // Caso 2: Problema con servicio (ej. internet lento)
    problema_servicio: `Eres un agente de soporte técnico de primer nivel. El cliente reporta un problema con su servicio (como internet lento) y tu objetivo es diagnosticar la causa y guiarlo paso a paso hacia la solución.
Lineamientos:
- Haz preguntas específicas para acotar el problema antes de dar soluciones.
- Guía al cliente con pasos claros y numerados, uno a la vez.
- Confirma si cada paso funcionó antes de continuar.
- Si el problema no se resuelve con los pasos básicos, escala a soporte técnico especializado.
- Responde siempre en español y de forma concisa.`,

    // Caso 3: Devolución de producto dañado
    devolucion_producto: `Eres un agente de atención al cliente especializado en devoluciones. El cliente recibió un artículo dañado y tu objetivo es gestionar todo el proceso de devolución de forma autónoma, sin que el cliente tenga que hablar con nadie más.
Lineamientos:
- Ofrece disculpas sinceras desde el inicio.
- Solicita los datos necesarios (número de pedido, foto del daño si aplica).
- Explica el proceso paso a paso: recolección, revisión y reembolso o reposición.
- Confirma los tiempos estimados de resolución.
- Haz que el cliente sienta que el problema quedará resuelto sin mayor esfuerzo de su parte.
- Responde siempre en español y de forma concisa.`,
  },

  // ── DEFAULT ───────────────────────────────────────────────────────────────
  default: `Eres un asistente virtual profesional. Responde de manera amable, clara y concisa. Siempre en español.`,
};

function getSystemPrompt(tipoAgente, tipoEscenario) {
  return SYSTEM_PROMPTS[tipoAgente]?.[tipoEscenario]
    || SYSTEM_PROMPTS[tipoAgente]?.default
    || SYSTEM_PROMPTS.default;
}


// ===========================
// ==== MENSAJES INICIALES ===
// ===========================

const MENSAJES_INICIALES = {
  cobranza: {
    pago_vencido: `Hola, buen día. Te contactamos de parte de nuestro equipo de cobranza porque detectamos una factura vencida en tu cuenta. No te preocupes, estamos aquí para ayudarte a resolverlo rápido. ¿Tienes un momento?`,
    plan_pagos: `Hola. Sabemos que a veces las deudas se acumulan y queremos ayudarte a salir adelante. Tenemos opciones de pago en cuotas que pueden adaptarse a tu situación. ¿Quieres que te explique cómo funciona?`,
    recordatorio_preventivo: `⏰ Hola, solo un aviso rápido: tu próximo pago vence mañana. Para que no se generen cargos por mora, te ayudamos a completarlo hoy mismo. ¿Por cuál método prefieres pagar?`,
  },
  marketing: {
    promo_exclusiva: `¡Hola! 🎉 Tenemos algo especial para ti. Por ser uno de nuestros clientes más valorados, tienes acceso a un 30% de descuento exclusivo de temporada. Es solo por tiempo limitado. ¿Te cuento cómo aplicarlo?`,
    carrito_abandonado: `Hola 👀 Notamos que dejaste unos productos seleccionados hace un par de días y no queremos que te quedes sin ellos. Para que los hagas tuyos hoy, te regalamos el envío completamente gratis 🚚. ¿Completamos tu pedido?`,
    upgrade_plan: `Hola. Revisando tu cuenta vemos que le estás sacando mucho provecho a tu plan actual, ¡qué bueno! Eso nos dice que quizás ya lo estás superando. Tenemos un plan superior con beneficios que se ajustan mejor a tu ritmo, y por ser cliente actual tienes precio preferencial. ¿Te interesa saber más?`,
  },
  atencion_cliente: {
    estado_pedido: `Hola, ¿cómo estás? 📦 Estoy aquí para ayudarte a rastrear tu pedido en tiempo real. Solo dime tu número de orden y te doy la información al instante.`,
    problema_servicio: `Hola. Lamentamos que estés teniendo problemas con tu servicio, entendemos lo frustrante que puede ser. Cuéntame con detalle qué está pasando y lo solucionamos juntos paso a paso. 🔧`,
    devolucion_producto: `Hola, qué pena que hayas recibido un producto en mal estado. 😟 Me encargo personalmente de gestionar tu devolución para que no tengas que hablar con nadie más. ¿Me compartes tu número de pedido y una foto del artículo?`,
  },
  default: `Hola 👋 ¿En qué te puedo ayudar hoy?`,
};

function getMensajeInicial(tipoAgente, tipoEscenario) {
  return MENSAJES_INICIALES[tipoAgente]?.[tipoEscenario]
    || MENSAJES_INICIALES[tipoAgente]?.default
    || MENSAJES_INICIALES.default;
}


// ===========================
// ======= UTILIDADES ========
// ===========================

function normalizarNumeroMX(numero) {
  let limpio = numero.replace(/\D/g, '');
  if (limpio.startsWith('52') && limpio.length === 12) {
    limpio = `521${limpio.slice(2)}`;
  }
  return limpio;
}

async function enviarWhatsApp(chatId, mensaje) {
  const url = `https://api.green-api.com/waInstance${process.env.GREENAPI_INSTANCE_ID}/sendMessage/${process.env.GREENAPI_API_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message: mensaje })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || `Green API error: ${response.status}`);
  }
  return response.json();
}


// ===========================
// ======= ENDPOINTS =========
// ===========================


// Endpoint 1: Recibir datos del formulario de contacto
app.post('/api/formulario-contacto', formularioLimiter, async (req, res) => {
  const { nombreCliente, nombreEmpresa, email, descripcion } = req.body;

  // Aquí puedes procesar los datos
  console.log('Datos recibidos:', {
    nombreCliente,
    nombreEmpresa,
    email,
    descripcion
  });

  // Configurar el contenido del correo
  const mailOptions = {
    from: '"Formulario de Contacto" <TU_CORREO@gmail.com>',
    to: process.env.EMAIL_TO,
    subject: `Nuevo contacto de ${nombreCliente} - ${nombreEmpresa}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
            }
            .container {
              background-color: #f9f9f9;
              border-radius: 8px;
              padding: 30px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            h2 {
              color: #2c3e50;
              border-bottom: 3px solid #3498db;
              padding-bottom: 10px;
            }
            .field {
              margin-bottom: 20px;
              background-color: white;
              padding: 15px;
              border-radius: 5px;
              border-left: 4px solid #3498db;
            }
            .label {
              font-weight: bold;
              color: #2c3e50;
              margin-bottom: 5px;
              display: block;
            }
            .value {
              color: #555;
            }
            .footer {
              margin-top: 30px;
              text-align: center;
              font-size: 12px;
              color: #888;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>📋 Nuevo Formulario de Contacto</h2>

            <div class="field">
              <span class="label">👤 Nombre del Cliente:</span>
              <span class="value">${nombreCliente}</span>
            </div>

            <div class="field">
              <span class="label">🏢 Nombre de la Empresa:</span>
              <span class="value">${nombreEmpresa}</span>
            </div>

            <div class="field">
              <span class="label">📧 Email:</span>
              <span class="value">${email}</span>
            </div>

            <div class="field">
              <span class="label">📝 Descripción:</span>
              <div class="value">${descripcion}</div>
            </div>

            <div class="footer">
              <p>Este correo fue enviado automáticamente desde el formulario de contacto</p>
              <p>Fecha: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</p>
            </div>
          </div>
        </body>
      </html>
    `
  };

  try {
    // Enviar el correo
    await transporter.sendMail(mailOptions);

    res.status(200).json({
      mensaje: 'Formulario recibido y correo enviado correctamente',
      datos: { nombreCliente, nombreEmpresa, email, descripcion }
    });
  } catch (error) {
    console.error('Error al enviar el correo:', error);
    res.status(500).json({
      mensaje: 'Formulario recibido pero hubo un error al enviar el correo',
      error: error.message
    });
  }
});

// Endpoint 2: Recibir y guardar configuración del agente activo + enviar mensaje inicial
app.post('/api/configuracion-agente', formularioLimiter, async (req, res) => {
  const { tipoAgente, tipoEscenario, canalContacto, numeroTelefono } = req.body;

  if (!numeroTelefono) {
    return res.status(400).json({ mensaje: 'El campo numeroTelefono es obligatorio' });
  }

  try {
    await redis.set('agent:config', { tipoAgente, tipoEscenario, canalContacto, numeroTelefono });
    console.log('Configuración guardada:', { tipoAgente, tipoEscenario, canalContacto, numeroTelefono });

    const mensajeInicial = getMensajeInicial(tipoAgente, tipoEscenario);

    // Guardar mensaje inicial en el historial (como si lo hubiera enviado el agente)
    const chatId = `${normalizarNumeroMX(numeroTelefono)}@c.us`;
    const historialKey = `historial:${chatId}`;
    await redis.set(historialKey, [
      { role: 'user', parts: [{ text: 'Inicia la conversación' }] },
      { role: 'model', parts: [{ text: mensajeInicial }] }
    ], { ex: 86400 });

    // Enviar por WhatsApp
    await enviarWhatsApp(chatId, mensajeInicial);
    console.log('Mensaje inicial enviado:', { chatId, tipoAgente, tipoEscenario });

    res.status(200).json({
      mensaje: 'Agente configurado y mensaje inicial enviado',
      datos: { tipoAgente, tipoEscenario, canalContacto, numeroTelefono },
    });
  } catch (error) {
    console.error('Error al configurar agente:', error);
    res.status(500).json({ mensaje: 'Error al configurar el agente', error: error.message });
  }
});

// Endpoint 3: Enviar mensaje de WhatsApp via Green API
app.post('/api/whatsapp/enviar-mensaje', formularioLimiter, async (req, res) => {
  const { numero, mensaje, tipoAgente, tipoEscenario } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ mensaje: 'Los campos numero y mensaje son obligatorios' });
  }

  const chatId = `${normalizarNumeroMX(numero)}@c.us`;

  try {
    const data = await enviarWhatsApp(chatId, mensaje);
    console.log('Mensaje enviado:', { tipoAgente, tipoEscenario, destinatario: numero, idMensaje: data.idMessage });

    res.status(200).json({
      mensaje: 'Mensaje enviado correctamente',
      destinatario: numero,
      tipoAgente: tipoAgente || null,
      tipoEscenario: tipoEscenario || null,
      idMensaje: data.idMessage
    });
  } catch (error) {
    console.error('Error al enviar mensaje de WhatsApp:', error);
    res.status(500).json({ mensaje: 'Error al enviar el mensaje', error: error.message });
  }
});

// Endpoint 4: Webhook — recibe mensajes entrantes de Green API y responde con el agente IA
app.post('/api/whatsapp/webhook', async (req, res) => {
  const { typeWebhook, senderData, messageData } = req.body;

  // Solo procesar mensajes de texto entrantes
  if (typeWebhook !== 'incomingMessageReceived' || messageData?.typeMessage !== 'textMessage') {
    return res.status(200).json({ ok: true });
  }

  const chatId = senderData.sender;
  const mensajeUsuario = messageData.textMessageData.textMessage;

  console.log('Mensaje entrante:', { chatId, mensaje: mensajeUsuario });

  try {
    // Obtener configuración del agente activo e historial en paralelo
    const [agentConfig, historial] = await Promise.all([
      redis.get('agent:config'),
      redis.get(`historial:${chatId}`),
    ]);

    const config = agentConfig || { tipoAgente: 'default', tipoEscenario: 'default' };
    const historialActual = historial || [];

    // Generar respuesta con Gemini
    const systemPrompt = getSystemPrompt(config.tipoAgente, config.tipoEscenario);
    const chat = geminiModel.startChat({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      history: historialActual,
    });

    const resultado = await chat.sendMessage(mensajeUsuario);
    const respuesta = resultado.response.text();

    // Guardar historial actualizado y enviar respuesta en paralelo
    const historialActualizado = [
      ...historialActual,
      { role: 'user', parts: [{ text: mensajeUsuario }] },
      { role: 'model', parts: [{ text: respuesta }] },
    ].slice(-20);

    await Promise.all([
      redis.set(`historial:${chatId}`, historialActualizado, { ex: 86400 }),
      enviarWhatsApp(chatId, respuesta),
    ]);

    console.log('Respuesta enviada:', { chatId, agente: config.tipoAgente, escenario: config.tipoEscenario });

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(200).json({ ok: true }); // siempre 200 para que Green API no reintente
  }
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
