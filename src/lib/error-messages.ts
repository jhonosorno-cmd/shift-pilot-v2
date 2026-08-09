export function errorMessageFor(code?: string): string {
  switch (code) {
    case 'invalid_api_key':
      return 'El servicio de IA no está disponible (credencial inválida). Contacta al supervisor.';
    case 'rate_limited':
      return 'El servicio de IA está saturado. Espera unos segundos e intenta de nuevo.';
    case 'output_truncated':
      return 'El reporte es demasiado largo para procesarlo de una vez. Acorta la transcripción o divídela en dos partes.';
    case 'invalid_model_output':
      return 'La IA devolvió una respuesta que no se pudo interpretar. Intenta de nuevo.';
    case 'model_error':
      return 'El servicio de IA falló al procesar el reporte. Intenta de nuevo en un momento.';
    case 'extraction_failed':
      return 'No se pudo procesar el traspaso. Intenta de nuevo.';
    default:
      return 'Ocurrió un error al procesar el traspaso. Intenta de nuevo.';
  }
}