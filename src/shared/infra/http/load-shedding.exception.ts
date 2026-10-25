import { ServiceUnavailableException } from '@nestjs/common';

// Recusa por excesso de carga (ex.: fila do Argon2 cheia). Vira 503 como qualquer ServiceUnavailable, mas o filtro
// só loga em warn e não manda ao Sentry: sob ataque, cada recusa viraria um evento.
export class LoadSheddingException extends ServiceUnavailableException {}
