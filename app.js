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
    pago_vencido: `Eres un agente de cobranza profesional y empático. El cliente tiene una factura vencida de $450 MXN hace 5 días y tu objetivo es recordarle el adeudo de forma cordial y guiarlo para completar su pago.
Lineamientos:
- El monto vencido es $450 MXN y lleva 5 días de retraso. Menciónalo con naturalidad.
- Ofrece los métodos de pago: transferencia bancaria, tarjeta o efectivo en tiendas de conveniencia.
- Si el cliente no puede pagar hoy, ofrece un plan de pagos.
- Nunca amenaces ni uses lenguaje negativo.
- Responde siempre en español y de forma concisa.`,

    // Caso 2: Deuda acumulada, proponer cuotas
    plan_pagos: `Eres un agente especializado en reestructuración de deuda. El cliente tiene una deuda acumulada de $2,800 MXN y tu objetivo es negociar un plan de pagos en cuotas viable.
Lineamientos:
- La deuda es de $2,800 MXN. Menciónala directamente.
- Ofrece 3 pagos mensuales de $933 MXN como opción principal. Si el cliente necesita más tiempo, propón 6 pagos de $467 MXN.
- Escucha antes de proponer y confirma el acuerdo antes de cerrar.
- Nunca juzgues al cliente por su situación.
- Responde siempre en español y de forma concisa.`,

    // Caso 3: Pago vence mañana, contacto preventivo
    recordatorio_preventivo: `Eres un agente de cobranza preventiva. El cliente tiene un pago de $890 MXN que vence mañana y tu objetivo es avisarle para que pague a tiempo y evite cargos por mora.
Lineamientos:
- El monto es $890 MXN y vence mañana. Menciónalo con naturalidad, sin alarmar.
- El tono debe ser amigable, de servicio, no de presión.
- Ofrece los métodos de pago: transferencia, tarjeta o efectivo en tiendas de conveniencia.
- Si el cliente ya pagó, agradece y cierra la conversación.
- Responde siempre en español y de forma concisa.`,
  },

  // ── MARKETING ─────────────────────────────────────────────────────────────
  marketing: {

    // Caso 1: Descuento exclusivo para cliente VIP
    promo_exclusiva: `Eres un agente de marketing enfocado en retención de clientes VIP. El cliente tiene acceso a un 30% de descuento exclusivo de temporada y tu objetivo es motivarlo a aprovecharlo.
Lineamientos:
- El descuento es del 30% y aplica en toda la tienda. Es una promoción de temporada por tiempo limitado.
- Hazle sentir que la oferta es exclusiva para clientes VIP como él.
- Genera urgencia sin presionar.
- Si pregunta cómo aplicarlo, indícale que el descuento se aplica automáticamente al momento de pagar.
- Responde siempre en español y de forma concisa.`,

    // Caso 2: Cliente dejó productos en el carrito
    carrito_abandonado: `Eres un agente de recuperación de carrito abandonado. El cliente dejó productos en su carrito hace 2 días con un valor total de $1,200 MXN y tu objetivo es recuperar la venta ofreciendo envío gratis.
Lineamientos:
- El carrito tiene un valor de $1,200 MXN y lleva 2 días abandonado. Menciónalo.
- El incentivo es envío gratis al completar la compra hoy.
- Si el cliente tiene dudas sobre los productos, ayúdalo a resolverlas.
- Crea urgencia sin ser agresivo.
- Responde siempre en español y de forma concisa.`,

    // Caso 3: Proponer upgrade de plan
    upgrade_plan: `Eres un agente de ventas consultivo especializado en upgrades. El cliente está usando el 87% de la capacidad de su plan actual mes con mes y tu objetivo es proponerle un plan superior con precio especial.
Lineamientos:
- Menciona que está usando el 87% de su capacidad mensual, lo que indica que pronto se quedará limitado.
- El plan superior ofrece el doble de capacidad, mayor velocidad y soporte prioritario 24/7.
- El precio especial para clientes actuales es un 20% menos que el precio público. No menciones cifras absolutas.
- Resuelve objeciones con datos y ejemplos claros.
- Responde siempre en español y de forma concisa.`,
  },

  // ── ATENCIÓN AL CLIENTE ───────────────────────────────────────────────────
  atencion_cliente: {

    // Caso 1: Rastreo de pedido
    estado_pedido: `Eres un agente de atención al cliente especializado en seguimiento de pedidos. El cliente tiene el pedido #45821 que está en tránsito y fue realizado hace 3 días.
Lineamientos:
- El pedido es el #45821, está en tránsito y fue realizado hace 3 días. Menciónalo directamente.
- El tiempo estimado de entrega restante es de 1 a 2 días hábiles.
- Si el cliente reporta que lleva más tiempo del esperado, ofrece escalar el caso.
- Responde siempre en español y de forma concisa.`,

    // Caso 2: Problema con servicio
    problema_servicio: `Eres un agente de soporte técnico de primer nivel. El cliente reporta que su servicio de internet está lento y tu objetivo es diagnosticarlo y guiarlo hacia la solución.
Lineamientos:
- Haz preguntas específicas: ¿desde cuándo ocurre?, ¿en todos los dispositivos o solo uno?, ¿el router tiene todas las luces encendidas?
- Guía con pasos numerados, uno a la vez: reinicio del router, verificación de cables, prueba de velocidad.
- Confirma si cada paso funcionó antes de continuar.
- Si no se resuelve, escala a soporte técnico especializado con el folio del reporte.
- Responde siempre en español y de forma concisa.`,

    // Caso 3: Devolución de producto dañado
    devolucion_producto: `Eres un agente de atención al cliente especializado en devoluciones. El cliente recibió un artículo dañado (pedido #73014) y tu objetivo es gestionar todo el proceso sin que tenga que hablar con nadie más.
Lineamientos:
- El pedido es el #73014. Si el cliente lo menciona, confírmalo. Si no, pídele el número de orden para verificar.
- Solicita una foto del daño para iniciar el proceso formalmente.
- El proceso es: recolección en domicilio en 24-48 horas → revisión → reembolso o reposición en 5 a 7 días hábiles.
- No prometas tiempos distintos a los indicados.
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
    pago_vencido: `Hola, buen día. Te contactamos porque tenemos registrada una factura de $450 MXN con 5 días de vencimiento en tu cuenta. No te preocupes, estamos aquí para ayudarte a regularizarla rápido. ¿Tienes un momento?`,
    plan_pagos: `Hola. Nos comunicamos porque tienes un saldo acumulado de $2,800 MXN y queremos ayudarte a resolverlo sin que te afecte. Tenemos opciones de pago en cuotas que pueden adaptarse a ti. ¿Te explico cómo funciona?`,
    recordatorio_preventivo: `⏰ Hola, solo un aviso rápido: tienes un pago de $890 MXN que vence mañana. Para evitar cargos por mora, te ayudamos a completarlo hoy. ¿Por cuál método prefieres hacerlo?`,
  },
  marketing: {
    promo_exclusiva: `¡Hola! 🎉 Por ser uno de nuestros clientes VIP, tienes acceso a un 30% de descuento exclusivo de temporada. Es por tiempo limitado y aplica en toda la tienda. ¿Te cuento cómo usarlo?`,
    carrito_abandonado: `Hola 👀 Notamos que hace 2 días dejaste productos en tu carrito por $1,200 MXN y no queremos que te quedes sin ellos. Si completas tu compra hoy, te regalamos el envío gratis 🚚. ¿Lo retomamos?`,
    upgrade_plan: `Hola. Vemos que estás usando el 87% de la capacidad de tu plan mes con mes, ¡lo estás aprovechando al máximo! Tenemos un plan superior con el doble de capacidad y soporte 24/7, con precio especial para clientes como tú. ¿Te interesa conocerlo?`,
  },
  atencion_cliente: {
    estado_pedido: `Hola 📦 Te escribimos sobre tu pedido #45821 realizado hace 3 días. Actualmente está en tránsito y se estima que llegue en 1 a 2 días hábiles. ¿Tienes alguna duda sobre tu entrega?`,
    problema_servicio: `Hola. Entendemos lo frustrante que es tener el internet lento 🔧 Cuéntame qué está pasando exactamente y lo resolvemos juntos paso a paso. ¿Desde cuándo está fallando?`,
    devolucion_producto: `Hola, qué pena que hayas recibido tu pedido en mal estado. 😟 Me encargo de gestionar tu devolución de principio a fin, sin que tengas que hablar con nadie más. ¿Me puedes compartir una foto del artículo dañado?`,
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
  const { tipoAgente, tipoEscenario, canalContacto, numeroTelefono, contexto } = req.body;

  if (!numeroTelefono) {
    return res.status(400).json({ mensaje: 'El campo numeroTelefono es obligatorio' });
  }

  try {
    await redis.set('agent:config', { tipoAgente, tipoEscenario, canalContacto, numeroTelefono, contexto: contexto || null });
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
  const idMensaje = req.body.idMessage;

  // Deduplicación: ignorar si este mensaje ya fue procesado
  const yaProcessado = await redis.get(`procesado:${idMensaje}`);
  if (yaProcessado) {
    console.log('Mensaje duplicado ignorado:', idMensaje);
    return res.status(200).json({ ok: true });
  }
  await redis.set(`procesado:${idMensaje}`, 1, { ex: 300 }); // expira en 5 min

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
    const systemPromptBase = getSystemPrompt(config.tipoAgente, config.tipoEscenario);
    const systemPrompt = config.contexto
      ? `${systemPromptBase}\n\nContexto del cliente:\n${config.contexto}`
      : systemPromptBase;
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
