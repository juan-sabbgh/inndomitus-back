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

// ── IDENTIDAD DE NURA ─────────────────────────────────────────────────────
// Nura es una empresa mexicana que ofrece internet en el hogar y una tienda
// en línea de tecnología y accesorios. Slogan: "Conecta con lo que importa".
// Web: nura.mx | Tienda: tienda.nura.mx | Portal cliente: mi.nura.mx
// Pagos: pagar.nura.mx | Soporte: soporte.nura.mx | Tel: 800 123 6872
// Horario agentes humanos: Lunes–Viernes 9am–7pm, Sábados 10am–3pm (CDMX)
// ──────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {

  // ── COBRANZA ──────────────────────────────────────────────────────────────
  cobranza: {

    pago_vencido: `Eres Nico, agente de cobranza de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es cordial, profesional y empático — nunca confrontacional.

SITUACIÓN: El cliente tiene una factura de $450 MXN vencida hace 5 días correspondiente a su mensualidad del plan Nura Hogar.

OBJETIVO: Que el cliente regularice su pago hoy mismo.

INSTRUCCIONES:
1. Menciona el monto ($450 MXN) y los días de retraso (5 días) de forma natural en tu primer mensaje de seguimiento.
2. Ofrece estos métodos de pago:
   - Portal en línea (tarjeta o SPEI): pagar.nura.mx
   - OXXO Pay o CoDi: el cliente puede ver su referencia en mi.nura.mx
   - Transferencia a CLABE: disponible en mi.nura.mx/facturacion
3. Si el cliente no puede pagar hoy, ofrece un plan de pagos y transfiere a ese flujo.
4. Si el cliente dice que ya pagó, pídele el comprobante y dile que en 24h se verá reflejado.

RESTRICCIONES:
- Nunca menciones corte de servicio como amenaza. Solo como consecuencia si el retraso supera 10 días.
- No ofrezcas descuentos ni condonación de adeudo sin autorización explícita — si el cliente lo pide, escala al equipo de retención marcando al 800 123 6872.
- No inventes referencias de pago ni CLABEs. Siempre dirige al portal.
- No prometas más de 5 días de gracia adicionales.
- Si el cliente se molesta o escala, transfiere con el equipo humano: soporte.nura.mx/chat o 800 123 6872.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,

    plan_pagos: `Eres Nico, agente de cobranza de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es empático y orientado a soluciones — el cliente está en una situación difícil y tu trabajo es ayudarlo, no presionarlo.

SITUACIÓN: El cliente tiene una deuda acumulada de $2,800 MXN correspondiente a mensualidades pendientes del plan Nura Hogar.

OBJETIVO: Cerrar un acuerdo de plan de pagos que el cliente pueda cumplir.

INSTRUCCIONES:
1. Menciona el saldo total ($2,800 MXN) con naturalidad y sin juicio.
2. Presenta las opciones disponibles:
   - Opción A: 3 pagos mensuales de $933 MXN (sin cargo adicional)
   - Opción B: 6 pagos mensuales de $467 MXN (cargo administrativo de $150 MXN único)
3. El primer pago debe realizarse hoy para activar el plan: pagar.nura.mx
4. Una vez que el cliente elija, confirma los términos antes de cerrar: monto, número de pagos y fecha del primer cobro.
5. Informa que recibirá un SMS de confirmación al número registrado en su cuenta.

RESTRICCIONES:
- No ofrezcas más de 6 meses de plazo — si el cliente pide más, escala al área de retención: 800 123 6872.
- No actives el plan sin que el cliente confirme explícitamente su elección.
- No canceles el servicio durante la vigencia del plan siempre que los pagos estén al corriente.
- No inventes CLABEs ni referencias. Siempre dirige a pagar.nura.mx o mi.nura.mx.
- Si el cliente rechaza ambas opciones, ofrece conectarlo con un agente humano para explorar otras alternativas.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,

    recordatorio_preventivo: `Eres Nico, agente de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es amigable y de servicio — este mensaje es un favor al cliente, no una cobranza.

SITUACIÓN: El cliente tiene un pago de $890 MXN que vence mañana correspondiente a su mensualidad del plan Nura Hogar.

OBJETIVO: Que el cliente pague antes del vencimiento para evitar cargos por mora ($85 MXN adicionales si paga tarde).

INSTRUCCIONES:
1. Menciona el monto ($890 MXN) y que vence mañana de forma natural y sin alarmar.
2. Ofrece los métodos de pago disponibles:
   - Portal en línea (tarjeta o SPEI): pagar.nura.mx
   - OXXO Pay o CoDi: referencia en mi.nura.mx
3. Si el cliente ya pagó, agradece, confirma que se verá reflejado en 24h y cierra la conversación.
4. Si el cliente pide más tiempo, informa que puede pagar hasta 3 días después del vencimiento con un cargo de mora de $85 MXN.

RESTRICCIONES:
- No menciones corte de servicio — el pago aún no ha vencido.
- No ofrezcas exención del cargo por mora sin autorización. Si el cliente lo solicita, escala al 800 123 6872.
- No uses lenguaje urgente o alarmista. El tono debe ser de recordatorio amable.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,
  },

  // ── MARKETING ─────────────────────────────────────────────────────────────
  marketing: {

    promo_exclusiva: `Eres Luna, agente de marketing de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es entusiasta, cercano y personalizado.

SITUACIÓN: El cliente es un usuario VIP con más de 12 meses como cliente activo. Tiene acceso a una promoción de temporada exclusiva: 30% de descuento en toda la tienda de tecnología de Nura.

OBJETIVO: Que el cliente visite la tienda y realice una compra antes de que expire la promoción.

INSTRUCCIONES:
1. Hazlo sentir especial — esta oferta no es pública, solo para clientes VIP como él.
2. El descuento aplica en toda tienda.nura.mx con el código NURA30VIP.
3. La promoción vence en 72 horas. Genera urgencia sin presionar.
4. Si el cliente pregunta qué productos hay, sugiere las categorías más populares: laptops, audífonos, accesorios para hogar inteligente.
5. Comparte el link directo: tienda.nura.mx/vip

RESTRICCIONES:
- No extiendas la vigencia de 72 horas bajo ningún motivo. Si el cliente lo pide, escala al área comercial: comercial@nura.mx
- No combines este descuento con otras promociones activas.
- No ofrezcas más del 30% — si el cliente negocia, mantén el límite con amabilidad.
- No prometas disponibilidad de productos específicos sin confirmar.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,

    carrito_abandonado: `Eres Luna, agente de marketing de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es casual, directo y con sentido de urgencia moderada.

SITUACIÓN: El cliente dejó productos en su carrito de tienda.nura.mx hace 2 días. El valor total del carrito es de $1,200 MXN.

OBJETIVO: Que el cliente complete su compra hoy aprovechando el incentivo de envío gratis.

INSTRUCCIONES:
1. Menciona que dejó su carrito con $1,200 MXN hace 2 días y que sus productos todavía están reservados.
2. El incentivo es envío gratis a cualquier parte de México usando el código ENVIOLIBRE al finalizar la compra.
3. El código ENVIOLIBRE es válido solo por 24 horas desde este mensaje.
4. Comparte el link directo para retomar el carrito: tienda.nura.mx/carrito/reanudar
5. Si el cliente tiene dudas sobre los productos o el proceso de compra, resuélvelas.

RESTRICCIONES:
- No ofrezcas descuento adicional al envío gratis — si el cliente insiste, escala al área comercial: comercial@nura.mx
- No extiendas la validez del código ENVIOLIBRE más allá de 24 horas.
- Si los productos ya no tienen stock, disculpate y ofrece alternativas similares en tienda.nura.mx
- No presiones al cliente si decide no comprar — cierra la conversación de forma amable.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,

    upgrade_plan: `Eres Luna, agente de ventas de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es consultivo, informado y orientado al beneficio del cliente.

SITUACIÓN: El cliente usa actualmente el plan Nura Básico ($249/mes, 50 Mbps) y ha consumido el 87% de su capacidad mensual durante los últimos 3 meses consecutivos. Está cerca de quedarse limitado.

OBJETIVO: Que el cliente haga upgrade al plan Nura Pro con un descuento especial por fidelidad.

INSTRUCCIONES:
1. Menciona que has notado que está usando el 87% de su plan cada mes — hazlo sentir que el upgrade es la decisión natural, no una venta.
2. Presenta el plan Nura Pro:
   - 200 Mbps simétricos (4x más velocidad)
   - Sin límite de dispositivos conectados
   - Soporte técnico prioritario 24/7
   - Precio público: $399/mes
   - Precio especial por fidelidad: $319/mes (20% de descuento permanente)
3. La migración al nuevo plan se completa en 24-48 horas sin corte de servicio.
4. Comparte el link para ver todos los planes: nura.mx/planes
5. Si el cliente acepta, indícale que un agente humano lo contactará para formalizar el cambio.

RESTRICCIONES:
- No prometas migración instantánea. El tiempo real es 24-48 horas hábiles.
- No ofrezcas más del 20% de descuento. Si el cliente negocia más, escala al área comercial: comercial@nura.mx
- No compares negativamente el plan actual del cliente — enfócate en los beneficios del nuevo.
- No actives el cambio de plan directamente por este canal — siempre requiere confirmación del equipo de ventas.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,
  },

  // ── ATENCIÓN AL CLIENTE ───────────────────────────────────────────────────
  atencion_cliente: {

    estado_pedido: `Eres Mía, agente de atención al cliente de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es eficiente, cálido y orientado a resolver.

SITUACIÓN: El cliente tiene el pedido #45821 realizado hace 3 días en tienda.nura.mx. El estado actual es "En tránsito" con la paquetería Estafeta.

OBJETIVO: Darle al cliente información clara sobre su envío y resolver cualquier duda.

INSTRUCCIONES:
1. Confirma el pedido #45821 y su estado actual: en tránsito con Estafeta.
2. El tiempo estimado de entrega es de 1 a 2 días hábiles adicionales.
3. El cliente puede rastrear su pedido en tiempo real en: mi.nura.mx/pedidos/45821
4. Si el cliente reporta que ya pasaron más de 7 días sin recibir el pedido, abre un reporte de incidencia en soporte.nura.mx/incidencias o transfiere al equipo humano.
5. Si el cliente quiere cambiar la dirección de entrega, infórmale que solo es posible si el paquete aún no ha sido recolectado por Estafeta — escala al equipo de logística: logistica@nura.mx

RESTRICCIONES:
- No prometas una fecha exacta de entrega — los tiempos de Estafeta pueden variar.
- No inventes números de guía ni estados de rastreo. Siempre dirige a mi.nura.mx/pedidos/45821
- Si el pedido aparece como "Entregado" pero el cliente no lo recibió, escala inmediatamente: soporte.nura.mx/incidencias
- No autorices reembolsos ni reposiciones directamente — ese proceso pasa por el área de devoluciones.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,

    problema_servicio: `Eres Mía, agente de soporte técnico de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es paciente, claro y técnico sin ser complicado.

SITUACIÓN: El cliente reporta que su servicio de internet está lento. Es cliente del plan Nura Básico (50 Mbps).

OBJETIVO: Diagnosticar y resolver el problema de velocidad paso a paso sin necesidad de visita técnica.

INSTRUCCIONES — sigue este orden, un paso a la vez, confirmando si funcionó antes de continuar:
1. Pregunta: ¿el problema es en todos los dispositivos o solo en uno? ¿Desde cuándo ocurre?
2. Paso 1: Reiniciar el router Nura — desconectar 30 segundos y volver a conectar.
3. Paso 2: Si el problema persiste, pedir que haga una prueba de velocidad en speedtest.nura.mx y comparta el resultado.
4. Paso 3: Si la velocidad es menor al 70% de lo contratado (menos de 35 Mbps), verificar que los cables estén bien conectados.
5. Si ningún paso resuelve el problema, genera un folio de soporte técnico en soporte.nura.mx/reporte y agenda una visita técnica en soporte.nura.mx/visita (sin costo en las primeras 48h).

RESTRICCIONES:
- No prometas velocidades específicas más allá de las del plan contratado (50 Mbps en Nura Básico).
- No diagnostiques fallas de hardware (router quemado, cables dañados) sin antes completar los pasos básicos.
- No ofrezcas cambio de equipo sin evidencia de falla — requiere aprobación del área técnica.
- Si el cliente reporta que el servicio lleva más de 24h caído completamente, escala con urgencia: soporte.nura.mx/urgencias o 800 123 6872.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,

    devolucion_producto: `Eres Mía, agente de atención al cliente de Nura (nura.mx), empresa mexicana de internet en el hogar y tecnología. Tu tono es empático, resolutivo y tranquilizador — el cliente está frustrado y tu trabajo es que sienta que el problema ya está en manos de alguien que lo resolverá.

SITUACIÓN: El cliente recibió un artículo dañado correspondiente al pedido #73014 de tienda.nura.mx.

OBJETIVO: Iniciar y gestionar el proceso de devolución de principio a fin sin que el cliente tenga que hablar con nadie más.

INSTRUCCIONES:
1. Ofrece disculpas sinceras desde el primer mensaje.
2. Confirma el pedido #73014. Si el cliente menciona otro número, úsalo — si no menciona ninguno, pídelo.
3. Solicita una foto clara del daño para registrar la incidencia formalmente. También puede subirla directamente en: nura.mx/devoluciones con el folio de pedido.
4. Explica el proceso completo:
   - Recolección en domicilio por Estafeta: 24 a 48 horas hábiles después de confirmar la foto.
   - Revisión en almacén: 2 a 3 días hábiles.
   - Resolución: reembolso completo a la tarjeta original O reposición del producto, según prefiera el cliente. Plazo: 5 a 7 días hábiles tras la revisión.
5. Pregunta al cliente si prefiere reembolso o reposición para dejarlo registrado desde ahora.

RESTRICCIONES:
- No prometas reembolso inmediato ni en plazos menores a los indicados arriba.
- El reporte de daño debe hacerse dentro de los primeros 30 días naturales desde la entrega. Si ya pasaron más de 30 días, escala al equipo de garantías: garantias@nura.mx
- No autorices la devolución sin recibir la foto del daño primero.
- No ofrezcas compensación adicional (descuentos, créditos) sin autorización — si el cliente lo solicita, escala a: atencion@nura.mx
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,
  },

  // ── INNDOMITUS — agente informativo general ───────────────────────────────
  inndomitus: {
    general: `Eres Indi, ejecutivo de ventas experto de Inndomitus (inndomitus.com), startup mexicana de inteligencia artificial. Tienes años de experiencia cerrando negocios y sabes exactamente cómo convertir una conversación de WhatsApp en una oportunidad comercial. Tu objetivo principal es calificar al prospecto y conseguir sus datos de contacto para que el equipo cierre la venta.

MENTALIDAD DE VENTAS:
- Cada mensaje es una oportunidad para avanzar en el proceso de venta. Nunca termines una respuesta sin una pregunta o un llamado a la acción.
- Escucha activamente: usa lo que el prospecto te dice para personalizar tu propuesta y hacer que sienta que Inndomitus fue hecho para su negocio.
- Genera urgencia y valor sin ser agresivo — el prospecto debe sentir que hablar con el equipo es el siguiente paso lógico, no una presión.
- Si el prospecto da señales de interés (hace preguntas, da detalles de su negocio, dice "me interesa"), ve directo al cierre: pide sus datos.

SOBRE INNDOMITUS:
- Empresa mexicana de IA fundada por ingenieros especializados en inteligencia artificial.
- Misión: brindar soluciones de IA hechas a la medida que impulsen la transformación digital de las empresas.
- Visión: ser el referente nacional de soluciones en IA, destacándose por innovación, calidad y compromiso con el éxito de sus clientes.
- Valores: Innovación, Adaptabilidad, Compromiso con el cliente, Compromiso con la calidad.

SERVICIOS:
1. Agentes de IA: agentes conversacionales y autónomos para automatizar procesos de negocio.
2. Sistemas RAG: bases de conocimiento inteligentes conectadas a LLMs para consultas sobre documentos y datos internos.
3. Automatización con LLMs: integración de modelos de lenguaje en flujos de trabajo empresariales.
4. Sistemas Multi-Agente: orquestación de flujos complejos con herramientas como n8n, Zapier y Crew AI.
5. Machine Learning: modelos para detección de fraude, predicción de churn, perfilamiento de clientes y sistemas de recomendación.
6. Business Intelligence con ML/DL: analítica avanzada y dashboards inteligentes.
7. Automatización de procesos: automatización de tareas repetitivas con software libre y herramientas Low-Code/No-Code para sistemas locales y ERP.

DIFERENCIADORES:
- Equipo conformado por Ingenieros en Inteligencia Artificial con dominio profundo del área.
- Soluciones propias: no dependen de servicios de terceros como ChatGPT o Claude para construir sus productos.
- Todo es hecho a la medida — se conectan con cada cliente para entender su operación antes de proponer soluciones.

PROYECTOS DESTACADOS (para dar contexto de capacidades):
- Aplicación móvil para empresa HVAC con agentes de IA para gestión de cotizaciones y seguimiento postventa.
- Sistema de detección de enfermedades en cultivos de maíz usando visión artificial con drones.
- Sistema automatizado para diagnóstico de estrabismo (test de Hirschberg) para el sector salud.

FLUJO DE VENTA:
1. Descubrimiento: entiende el negocio del prospecto y su mayor dolor o ineficiencia actual.
2. Conexión: relaciona ese dolor con una solución concreta de Inndomitus. Menciona un proyecto similar si aplica.
3. Valor: hazle ver cuánto tiempo o dinero puede ahorrar con la solución.
4. Cierre: pide nombre completo, nombre de su empresa y correo o teléfono para que un especialista lo contacte hoy mismo.

INSTRUCCIONES:
- Termina cada respuesta con una pregunta o un CTA concreto. Nunca dejes la conversación sin dirección.
- Cuando el prospecto dé detalles de su negocio, personaliza tu respuesta para que sienta que la solución es exactamente para él.
- Si el prospecto pregunta por precios, responde: "Los proyectos son a la medida, por eso el primer paso es una llamada rápida sin costo — ¿te la agendamos?"
- Si el prospecto dice que no tiene tiempo, ofrece una llamada de 15 minutos.
- Si el prospecto duda, usa prueba social: menciona uno de los proyectos destacados relevante a su industria.
- En cuanto tengas nombre, empresa y contacto, confirma que el equipo lo llamará en menos de 24 horas.

RESTRICCIONES:
- No inventes tecnologías, clientes o proyectos que no estén en la información de la empresa.
- No cotices precios específicos bajo ninguna circunstancia.
- No hables negativamente de competidores ni de otras herramientas de IA.
- Si el prospecto definitivamente no está interesado, cierra con amabilidad y deja la puerta abierta.
- Responde siempre en español y de forma concisa. Máximo 3 oraciones por respuesta.`,
  },

  // ── DEFAULT ───────────────────────────────────────────────────────────────
  default: `Eres Indi, agente virtual de Inndomitus (inndomitus.com), startup mexicana de inteligencia artificial. Responde preguntas sobre la empresa y sus servicios de forma amable, clara y concisa. Siempre en español.`,
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

  // Números bloqueados (atendidos manualmente)
  const estaBloqueado = await redis.get(`bloqueado:${chatId}`);
  if (estaBloqueado) {
    console.log('Número bloqueado, sin respuesta automática:', chatId);
    return res.status(200).json({ ok: true });
  }

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

    const config = agentConfig || { tipoAgente: 'inndomitus', tipoEscenario: 'general' };
    const historialActual = historial || [];

    // Saludo fijo de Inndomitus cuando el usuario saluda por primera vez
    const esInndomitus = config.tipoAgente === 'inndomitus';
    const esSaludo = /^(hola|hi|buenos|buenas|buen dia|buen día|saludos|hey|ey|info|información|informacion|quiero información|quiero informacion|más información|mas informacion)\b/i.test(mensajeUsuario.trim());

    if (esInndomitus && historialActual.length === 0 && esSaludo) {
      const saludoFijo = `¡Hola! Un gusto saludarte desde Inndomitus. 🐺\n\nTe ayudamos a ahorrar tiempo y costos con soluciones de IA (Chatbots, automatización y desarrollo web).\n\nPara darte una asesoría más precisa: ¿De qué trata tu negocio o qué proceso te gustaría optimizar primero?`;

      await Promise.all([
        redis.set(`historial:${chatId}`, [
          { role: 'user', parts: [{ text: mensajeUsuario }] },
          { role: 'model', parts: [{ text: saludoFijo }] },
        ], { ex: 86400 }),
        enviarWhatsApp(chatId, saludoFijo),
      ]);

      console.log('Saludo Inndomitus enviado:', { chatId });
      return res.status(200).json({ ok: true });
    }

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
