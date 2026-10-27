/* DISTRILOG internationalization: source language pt-BR, Spanish display catalog.
 * Whitelist-only translation: never rewrite operational IDs, user input or API payloads.
 * Works with dynamically rendered server/client views and is reversible per user.
 */
(function(root) {
  "use strict";
  const ES = Object.freeze({
  "Central de Operações": "Centro de Operaciones",
  "Visão da Missão": "Visión de la Misión",
  "Recebimento": "Recepción",
  "Qualidade": "Calidad",
  "Processamento": "Procesamiento",
  "Etiquetagem": "Etiquetado",
  "Estocagem": "Almacenamiento",
  "Mapa de endereçamento": "Mapa de ubicaciones",
  "Expedição": "Despacho",
  "Devoluções": "Devoluciones",
  "Conversas": "Conversaciones",
  "Calendário": "Calendario",
  "Cadastros": "Registros",
  "Cards de teste": "Tarjetas de prueba",
  "Sair": "Salir",
  "Operação": "Operación",
  "Saída e retorno": "Salida y devoluciones",
  "Equipe": "Equipo",
  "Gestão": "Gestión",
  "Usuário": "Usuario",
  "Usuários": "Usuarios",
  "Usuários e perfis": "Usuarios y perfiles",
  "Senha": "Contraseña",
  "Entrar": "Ingresar",
  "Atualizar": "Actualizar",
  "Ajuda": "Ayuda",
  "Idioma da interface": "Idioma de la interfaz",
  "Idioma": "Idioma",
  "Idioma / Idioma": "Idioma",
  "Português": "Portugués",
  "Produção, estoque, expedição e devoluções em um só lugar": "Producción, inventario, despacho y devoluciones en un solo lugar",
  "Defina sua senha": "Establezca su contraseña",
  "Troque a senha temporária antes de acessar o DISTRILOG.": "Cambie la contraseña temporal antes de acceder a DISTRILOG.",
  "Nova senha (12+ caracteres, letras e números)": "Nueva contraseña (más de 12 caracteres, letras y números)",
  "Confirme a nova senha": "Confirme la nueva contraseña",
  "Salvar senha e entrar": "Guardar contraseña e ingresar",
  "Cancelar": "Cancelar",
  "Voltar": "Volver",
  "Confirmar": "Confirmar",
  "Confirmar operação": "Confirmar operación",
  "Salvar": "Guardar",
  "Salvar alterações": "Guardar cambios",
  "Editar": "Editar",
  "Excluir": "Eliminar",
  "Adicionar": "Agregar",
  "Remover": "Quitar",
  "Fechar": "Cerrar",
  "Concluir": "Finalizar",
  "Finalizar": "Finalizar",
  "Continuar": "Continuar",
  "Avançar": "Continuar",
  "Próximo": "Siguiente",
  "Anterior": "Anterior",
  "Pesquisar": "Buscar",
  "Buscar (Ctrl + K)": "Buscar (Ctrl + K)",
  "Buscar": "Buscar",
  "Limpar": "Limpiar",
  "Limpar filtros": "Limpiar filtros",
  "Filtrar": "Filtrar",
  "Todos": "Todos",
  "Todas": "Todas",
  "Tudo": "Todo",
  "Nenhum": "Ninguno",
  "Nenhuma": "Ninguna",
  "Sim": "Sí",
  "Não": "No",
  "Opcional": "Opcional",
  "(opcional)": "(opcional)",
  "Obrigatório": "Obligatorio",
  "Obrigatória": "Obligatoria",
  "Não informado": "No informado",
  "Não informada": "No informada",
  "Não definido": "No definido",
  "Não definida": "No definida",
  "Sem informação": "Sin información",
  "Sem informações": "Sin información",
  "Sem dados": "Sin datos",
  "Carregando...": "Cargando...",
  "Carregando": "Cargando",
  "Processando...": "Procesando...",
  "Aguarde...": "Espere...",
  "Tentar novamente": "Intentar de nuevo",
  "Falha na conexão": "Error de conexión",
  "Falha de conexão": "Error de conexión",
  "Erro inesperado.": "Error inesperado.",
  "Erro inesperado": "Error inesperado",
  "Não foi possível carregar esta visão.": "No se pudo cargar esta vista.",
  "As senhas não coincidem.": "Las contraseñas no coinciden.",
  "Senha alterada. Entre novamente para iniciar uma sessão segura.": "Contraseña actualizada. Ingrese nuevamente para iniciar una sesión segura.",
  "Acesso negado": "Acceso denegado",
  "Acesso restrito": "Acceso restringido",
  "Sem permissão": "Sin permiso",
  "Operador": "Operador",
  "Operadores": "Operadores",
  "Colaborador": "Colaborador",
  "Colaboradores": "Colaboradores",
  "Funcionário": "Empleado",
  "Funcionários": "Empleados",
  "Responsável": "Responsable",
  "Atribuída": "Asignada",
  "Atribuído": "Asignado",
  "Setor": "Sector",
  "Setores": "Sectores",
  "Setor atual": "Sector actual",
  "Setor responsável": "Sector responsable",
  "Função / setor": "Función / sector",
  "Perfil": "Perfil",
  "Perfis": "Perfiles",
  "Nome": "Nombre",
  "Sobrenome": "Apellido",
  "Descrição": "Descripción",
  "Observação": "Observación",
  "Observações": "Observaciones",
  "Observação geral (opcional)": "Observación general (opcional)",
  "Motivo": "Motivo",
  "Justificativa": "Justificación",
  "Título": "Título",
  "Início": "Inicio",
  "Fim": "Fin",
  "Data": "Fecha",
  "Hora": "Hora",
  "Horário": "Horario",
  "Hoje": "Hoy",
  "Ontem": "Ayer",
  "Amanhã": "Mañana",
  "Semana": "Semana",
  "Mês": "Mes",
  "Ano": "Año",
  "Mês atual": "Mes actual",
  "Próximo mês ›": "Mes siguiente ›",
  "Dia inteiro": "Todo el día",
  "Prazo": "Plazo",
  "Reunião": "Reunión",
  "Nada marcado para este dia.": "No hay actividades programadas para este día.",
  "Compromisso salvo.": "Evento guardado.",
  "Compromisso excluído.": "Evento eliminado.",
  "Conversas e avisos": "Conversaciones y avisos",
  "Canais e conversas": "Canales y conversaciones",
  "Escreva uma mensagem e tecle Enter": "Escriba un mensaje y presione Enter",
  "Enviar": "Enviar",
  "Geral — toda a equipe": "General — todo el equipo",
  "Não foi possível atualizar os avisos de novas mensagens.": "No se pudieron actualizar los avisos de mensajes nuevos.",
  "Não foi possível carregar a conversa. A atualização automática tentará novamente.": "No se pudo cargar la conversación. La actualización automática volverá a intentarlo.",
  "Mensagens indisponíveis:": "Mensajes no disponibles:",
  "Resposta inválida ao consultar mensagens.": "Respuesta no válida al consultar mensajes.",
  "Não foi possível enviar:": "No se pudo enviar:",
  "Falha na conexão.": "Error de conexión.",
  "A conversa será atualizada novamente.": "La conversación volverá a actualizarse.",
  "Destinatário da conversa não encontrado.": "No se encontró el destinatario de la conversación.",
  "Dashboard": "Panel de control",
  "Visão geral": "Vista general",
  "Fila operacional": "Cola operativa",
  "Fila de operação": "Cola de operaciones",
  "Fila de recebimento": "Cola de recepción",
  "Fila de qualidade": "Cola de calidad",
  "Fila de processamento": "Cola de procesamiento",
  "Fila de etiquetagem": "Cola de etiquetado",
  "Fila de estocagem": "Cola de almacenamiento",
  "Central de Endereçamento": "Centro de ubicaciones",
  "WMS · CONTROLE": "WMS · CONTROL",
  "Controle de estoque": "Control de inventario",
  "Estoque": "Inventario",
  "Estoque disponível": "Inventario disponible",
  "Estoque atual": "Inventario actual",
  "Saldo": "Saldo",
  "Saldo atual": "Saldo actual",
  "Saldo geral": "Saldo general",
  "Saldo global do Card": "Saldo global de la tarjeta",
  "Saldo físico": "Saldo físico",
  "Saldo disponível": "Saldo disponible",
  "Saldo da referência": "Saldo de la referencia",
  "Volumes restantes no Card:": "Volúmenes restantes en la tarjeta:",
  "Ocupação": "Ocupación",
  "Capacidade": "Capacidad",
  "Capacidade utilizada": "Capacidad utilizada",
  "Disponível": "Disponible",
  "Disponíveis": "Disponibles",
  "Ocupado": "Ocupado",
  "Ocupada": "Ocupada",
  "Livre": "Libre",
  "Livres": "Libres",
  "Total": "Total",
  "Totais": "Totales",
  "Resumo": "Resumen",
  "Indicadores": "Indicadores",
  "Indicador": "Indicador",
  "Métricas": "Métricas",
  "Produtividade": "Productividad",
  "Produção": "Producción",
  "Produzido": "Producido",
  "Produzido semanal": "Producido semanal",
  "Produzido no mês": "Producido en el mes",
  "Backlog": "Pendiente inicial",
  "Backlog inicial da semana": "Pendiente inicial de la semana",
  "Somente backlog": "Solo pendiente inicial",
  "Backlog + produzido": "Pendiente inicial + producido",
  "QUADRO DO BACKLOG": "TABLERO DE PENDIENTES",
  "Quadro automático": "Tablero automático",
  "Quadro de tarefas": "Tablero de tareas",
  "Situação agora": "Situación actual",
  "Situação das capturas do mês": "Estado de las capturas del mes",
  "Histórico legado": "Historial anterior",
  "Histórico": "Historial",
  "Histórico de Entradas": "Historial de entradas",
  "Histórico de movimentações": "Historial de movimientos",
  "Atualizar dados ↻": "Actualizar datos ↻",
  "Atualizar ↻": "Actualizar ↻",
  "Fotografias operacionais: segunda 08h10 · quarta 12h · sexta 16h": "Capturas operativas: lunes 08:10 · miércoles 12:00 · viernes 16:00",
  "Backlog inicial fixo e produzido nos cortes oficiais da semana": "Pendiente inicial fijo y producción en los cortes oficiales de la semana",
  "Não há apontamento de peças concluídas confiável": "No hay datos confiables de piezas finalizadas",
  "Apontamento por setor ainda não estruturado": "Registro por sector aún no estructurado",
  "Nenhum item operacional encontrado no banco.": "No se encontraron artículos operativos en la base de datos.",
  "Horários oficiais": "Horarios oficiales",
  "Início dos dados automáticos: novembro de 2026 · sem edição ou cálculo retroativo": "Inicio de los datos automáticos: noviembre de 2026 · sin edición ni cálculo retroactivo",
  "Registrado": "Registrado",
  "Agendado": "Programado",
  "Não capturado": "No capturado",
  "Aguardando corte": "Esperando el corte",
  "Prévia": "Avance",
  "Final": "Final",
  "Fechamento": "Cierre",
  "Prévia · quarta 12h": "Avance · miércoles 12:00",
  "Fechamento · sexta 16h": "Cierre · viernes 16:00",
  "Backlog · segunda 08h10": "Pendiente inicial · lunes 08:10",
  "FONTE: SISTEMA · HORÁRIO DE BRASÍLIA": "FUENTE: SISTEMA · HORA DE BRASILIA",
  "Peças por estágio": "Piezas por etapa",
  "Peças": "Piezas",
  "peças": "piezas",
  "peça(s)": "pieza(s)",
  "Peças concluídas": "Piezas finalizadas",
  "Volumes": "Volúmenes",
  "volumes": "volúmenes",
  "volume(s)": "volumen(es)",
  "caixas pretas": "cajas negras",
  "Caixas pretas": "Cajas negras",
  "caixa(s)": "caja(s)",
  "Caixas": "Cajas",
  "Unidades": "Unidades",
  "Quantidade": "Cantidad",
  "Quantidade esperada": "Cantidad esperada",
  "Quantidade conferida": "Cantidad verificada",
  "Quantidade despachada": "Cantidad despachada",
  "Quantidade estocada": "Cantidad almacenada",
  "Qtd.": "Cant.",
  "Qtd. esperada": "Cant. esperada",
  "Qtd. compra": "Cant. de compra",
  "Qtd. recebida": "Cant. recibida",
  "Quantidade de volumes": "Cantidad de volúmenes",
  "Diferença": "Diferencia",
  "Diferenças": "Diferencias",
  "Divergência": "Divergencia",
  "Divergências": "Divergencias",
  "Sem divergência": "Sin divergencia",
  "Recontagem": "Recuento",
  "Conferência": "Verificación",
  "Conferência física": "Verificación física",
  "Conferência cega:": "Verificación a ciegas:",
  "Conferência cega": "Verificación a ciegas",
  "Conferir": "Verificar",
  "Conferir Entrada": "Verificar entrada",
  "Conferência pendente": "Verificación pendiente",
  "Itens": "Artículos",
  "Item": "Artículo",
  "Itens criados": "Artículos creados",
  "Itens localizados na Qualidade": "Artículos ubicados en Calidad",
  "Item indisponível": "Artículo no disponible",
  "Produto": "Producto",
  "Produtos": "Productos",
  "Referência": "Referencia",
  "Referências": "Referencias",
  "REFERÊNCIA": "REFERENCIA",
  "Referência selecionada": "Referencia seleccionada",
  "REFERÊNCIA SELECIONADA": "REFERENCIA SELECCIONADA",
  "Referência · cor · tamanho": "Referencia · color · talla",
  "SKU": "SKU",
  "Cor": "Color",
  "Cores": "Colores",
  "SEM COR": "SIN COLOR",
  "Sem cor": "Sin color",
  "Tamanho": "Talla",
  "Tamanhos": "Tallas",
  "Grade": "Desglose por tallas",
  "GRADE": "DESGLOSE POR TALLAS",
  "Grade — controle por item": "Desglose por tallas — control por artículo",
  "Grade alterada": "Desglose por tallas modificado",
  "Combinação extra": "Combinación adicional",
  "Fornecedor": "Proveedor",
  "Marca": "Marca",
  "Compra": "Compra",
  "Compras": "Compras",
  "Tipo da compra": "Tipo de compra",
  "Tipo de entrada": "Tipo de entrada",
  "Nota fiscal": "Factura",
  "Nº da nota fiscal": "N.º de factura",
  "Lote": "Lote",
  "Código": "Código",
  "Endereço": "Ubicación",
  "Endereços": "Ubicaciones",
  "Endereçamento": "Asignación de ubicaciones",
  "Endereçamento ainda não registrado": "Ubicación aún no registrada",
  "Nenhum endereço registrado": "No hay ubicaciones registradas",
  "Endereçamento no fechamento": "Asignación de ubicación al cierre",
  "Posição": "Posición",
  "Posições": "Posiciones",
  "Posição selecionada": "Posición seleccionada",
  "Todas as posições": "Todas las posiciones",
  "Carregando endereços...": "Cargando ubicaciones...",
  "Carregando posições ET...": "Cargando posiciones ET...",
  "Nenhum endereço foi retornado para o setor": "No se devolvieron ubicaciones para el sector",
  "Erro desconhecido ao consultar os endereços.": "Error desconocido al consultar las ubicaciones.",
  "O servidor retornou dados inválidos para o setor": "El servidor devolvió datos no válidos para el sector",
  "Casulo": "Casillero",
  "Casulos": "Casilleros",
  "Casulo atual": "Casillero actual",
  "Pesquisar compra, fornecedor, marca ou Casulo": "Buscar compra, proveedor, marca o casillero",
  "Compra, fornecedor, marca, produto ou Casulo": "Compra, proveedor, marca, producto o casillero",
  "Origem": "Origen",
  "Destino": "Destino",
  "Origem → destino": "Origen → destino",
  "Transferência": "Transferencia",
  "Transferir": "Transferir",
  "Movimentação": "Movimiento",
  "Movimentações": "Movimientos",
  "Movimentação física": "Movimiento físico",
  "Alocação": "Asignación",
  "Alocar": "Asignar ubicación",
  "Alocar referência": "Asignar ubicación a la referencia",
  "Alocação WMS": "Asignación WMS",
  "Volumes sem grade vinculada": "Volúmenes sin desglose por tallas vinculado",
  "Não dê baixa automaticamente.": "No registre la baja automáticamente.",
  "Verificação atrasada": "Verificación retrasada",
  "Card inexistente": "Tarjeta inexistente",
  "Nenhuma linha selecionada.": "No hay ninguna fila seleccionada.",
  "Escolha o destino e informe um motivo.": "Seleccione el destino e indique un motivo.",
  "Quantidade inválida para o saldo disponível.": "Cantidad no válida para el saldo disponible.",
  "Confirmar a movimentação física de": "Confirmar el movimiento físico de",
  "registrada com sucesso.": "registrada correctamente.",
  "Ainda não executada": "Aún no ejecutada",
  "Criar Card": "Crear tarjeta",
  "+ Criar Card": "+ Crear tarjeta",
  "Criar Card de teste": "Crear tarjeta de prueba",
  "+ Criar Card de teste": "+ Crear tarjeta de prueba",
  "Card": "Tarjeta",
  "Cards": "Tarjetas",
  "Abrir Card": "Abrir tarjeta",
  "Abrir controle →": "Abrir control →",
  "Excluir Card": "Eliminar tarjeta",
  "Excluir definitivamente o Card": "Eliminar definitivamente la tarjeta",
  "Cards criados": "Tarjetas creadas",
  "Material selecionado": "Material seleccionado",
  "materiais encontrados": "materiales encontrados",
  "Mostrar todos": "Mostrar todos",
  "Sem marca": "Sin marca",
  "Marcar como recebido": "Marcar como recibido",
  "Confirmar recebimento": "Confirmar recepción",
  "Mercadoria em trânsito": "Mercancía en tránsito",
  "No fornecedor": "En el proveedor",
  "Em trânsito": "En tránsito",
  "Trânsito": "Tránsito",
  "Tipo da compra definido.": "Tipo de compra definido.",
  "Card mantido no Recebimento": "Tarjeta mantenida en Recepción",
  "Confirmar que esta mercadoria chegou ao CD?": "¿Confirmar que esta mercancía llegó al centro de distribución?",
  "Andamento local preservado:": "Progreso local conservado:",
  "Vai para Costura": "Va a Costura",
  "Vai para a costura?": "¿Va a Costura?",
  "Na Costura": "En Costura",
  "Retornou da Costura": "Regresó de Costura",
  "Retorno da Costura CD01": "Regreso de Costura CD01",
  "Registrar retorno CD01": "Registrar regreso CD01",
  "CD02 — sai do fluxo interno": "CD02 — sale del flujo interno",
  "Aguardando Processamento": "Esperando Procesamiento",
  "Não classificado": "Sin clasificar",
  "Não reconhecido": "No reconocido",
  "Qualidade (QA)": "Calidad (QA)",
  "Recebimento (RM)": "Recepción (RM)",
  "Processamento (PR)": "Procesamiento (PR)",
  "Etiquetagem (ET)": "Etiquetado (ET)",
  "Estocagem (EC)": "Almacenamiento (EC)",
  "Qualidade 1": "Calidad 1",
  "Qualidade 2": "Calidad 2",
  "Inspeção": "Inspección",
  "Inspeções": "Inspecciones",
  "Inspecionada": "Inspeccionada",
  "Amostra": "Muestra",
  "Amostra reservada na Qualidade": "Muestra reservada en Calidad",
  "Selecionar amostra": "Seleccionar muestra",
  "Selecionar inspetor": "Seleccionar inspector",
  "Selecione o inspetor.": "Seleccione al inspector.",
  "Inspeção ágil e preenchimento guiado": "Inspección rápida y registro guiado",
  "Seleção compacta de materiais": "Selección compacta de materiales",
  "Entrada em estoque por tamanho ou saldo geral": "Ingreso al inventario por talla o saldo general",
  "Inspeção concluída": "Inspección finalizada",
  "Inspeção pendente": "Inspección pendiente",
  "Triagem": "Clasificación",
  "Triagem concluída": "Clasificación finalizada",
  "Cadastro": "Registro",
  "Entrada": "Entrada",
  "Entradas": "Entradas",
  "Entradas pendentes": "Entradas pendientes",
  "Aguardando triagem": "Esperando clasificación",
  "Aguardando etiquetagem": "Esperando etiquetado",
  "Aguardando estocagem": "Esperando almacenamiento",
  "Aguardando qualidade": "Esperando Calidad",
  "Aguardando inspeção": "Esperando inspección",
  "Aguardando recebimento": "Esperando recepción",
  "Aguardando processamento": "Esperando procesamiento",
  "Aguardando entrada": "Esperando entrada",
  "Aguardando": "Esperando",
  "Pendente": "Pendiente",
  "Pendentes": "Pendientes",
  "Em andamento": "En curso",
  "Iniciado": "Iniciado",
  "Iniciada": "Iniciada",
  "Pausado": "Pausado",
  "Pausada": "Pausada",
  "Concluído": "Finalizado",
  "Concluída": "Finalizada",
  "Finalizado": "Finalizado",
  "Finalizada": "Finalizada",
  "Disponível para iniciar": "Disponible para iniciar",
  "Status": "Estado",
  "Etapa": "Etapa",
  "Etapas": "Etapas",
  "Etapa atual": "Etapa actual",
  "Etapas e referências": "Etapas y referencias",
  "Tempo": "Tiempo",
  "Tempo útil": "Tiempo productivo",
  "Tempo parado": "Tiempo detenido",
  "Tempo total": "Tiempo total",
  "Tempo estimado": "Tiempo estimado",
  "Permanência": "Permanencia",
  "Data de criação": "Fecha de creación",
  "Criada": "Creada",
  "Criado": "Creado",
  "Criada por": "Creada por",
  "Concluída por": "Finalizada por",
  "Iniciar": "Iniciar",
  "Iniciar operação": "Iniciar operación",
  "Pausar": "Pausar",
  "Retomar": "Reanudar",
  "Finalizar operação": "Finalizar operación",
  "Selecionar": "Seleccionar",
  "Selecione": "Seleccione",
  "Selecione o colaborador.": "Seleccione al colaborador.",
  "Selecione o arquivo Excel.": "Seleccione el archivo Excel.",
  "Selecione o arquivo oficial": "Seleccione el archivo oficial",
  "Importação concluída.": "Importación finalizada.",
  "Erro na importação.": "Error durante la importación.",
  "Importar Excel": "Importar Excel",
  "Importar PDF": "Importar PDF",
  "Importar compras": "Importar compras",
  "Últimas importações": "Últimas importaciones",
  "Relatório de Compras": "Informe de Compras",
  "Leitura completa das compras operacionais": "Lectura completa de compras operativas",
  "Somente o Administrador pode importar arquivos.": "Solo el administrador puede importar archivos.",
  "Ferramentas de teste": "Herramientas de prueba",
  "Somente o Administrador pode excluir Cards.": "Solo el administrador puede eliminar tarjetas.",
  "Card de teste criado em": "Tarjeta de prueba creada en",
  "Card criado no fluxo normal de Recebimento": "Tarjeta creada en el flujo normal de Recepción",
  "Card enviado ao Processamento para teste.": "Tarjeta enviada a Procesamiento para pruebas.",
  "Retorno CD01 enviado ao Recebimento.": "Regreso CD01 enviado a Recepción.",
  "Enviar ao Processamento": "Enviar a Procesamiento",
  "Enviar diretamente ao Processamento para teste": "Enviar directamente a Procesamiento para pruebas",
  "Cadastro de usuários": "Registro de usuarios",
  "Criar login de operador": "Crear acceso para operador",
  "Criar login": "Crear acceso",
  "Login criado. Entregue a senha temporária ao operador por canal seguro.": "Acceso creado. Entregue la contraseña temporal al operador por un canal seguro.",
  "O colaborador deverá trocar a senha temporária no primeiro acesso.": "El colaborador deberá cambiar la contraseña temporal en su primer acceso.",
  "Senha temporária (12+ caracteres, letras e números)": "Contraseña temporal (más de 12 caracteres, letras y números)",
  "Nova senha temporária (12+ caracteres, letras e números)": "Nueva contraseña temporal (más de 12 caracteres, letras y números)",
  "Confirme sua senha de administrador": "Confirme su contraseña de administrador",
  "Sua senha de administrador": "Su contraseña de administrador",
  "Redefinir senha": "Restablecer contraseña",
  "Redefinir senha de operador": "Restablecer contraseña del operador",
  "Senha temporária redefinida. O operador precisa alterá-la no próximo login.": "Contraseña temporal restablecida. El operador debe cambiarla en su próximo ingreso.",
  "Nome ou função inválida.": "Nombre o función no válidos.",
  "Função inválida.": "Función no válida.",
  "Este usuário já existe.": "Este usuario ya existe.",
  "Usuário não encontrado.": "Usuario no encontrado.",
  "Somente um administrador pode redefinir senhas.": "Solo un administrador puede restablecer contraseñas.",
  "Apenas administradores podem criar logins.": "Solo los administradores pueden crear accesos.",
  "Senha do administrador inválida.": "Contraseña del administrador no válida.",
  "Idioma preferido": "Idioma preferido",
  "Idioma do operador": "Idioma del operador",
  "Preferência de idioma salva.": "Preferencia de idioma guardada.",
  "Configurações": "Configuración",
  "Grupos do último relatório": "Grupos del último informe",
  "Sem relatório": "Sin informe",
  "Linha": "Línea",
  "Linhas": "Líneas",
  "Nova linha": "Nueva línea",
  "+ Linha": "+ Línea",
  "+ Tamanho": "+ Talla",
  "Digite a cor": "Escriba el color",
  "Digite diretamente as cores e os tamanhos. Não existe cor ou tamanho pré-definido.": "Ingrese directamente los colores y las tallas. No hay colores ni tallas predefinidos.",
  "Adicione pelo menos uma linha e um tamanho para montar a grade.": "Agregue al menos una línea y una talla para armar el desglose.",
  "Informe a referência.": "Indique la referencia.",
  "Toda quantidade preenchida precisa ter cor e tamanho.": "Cada cantidad ingresada debe tener color y talla.",
  "Informe pelo menos uma quantidade maior que zero na grade.": "Indique al menos una cantidad mayor que cero en el desglose.",
  "Erro ao criar card:": "Error al crear la tarjeta:",
  "Total da referência:": "Total de la referencia:",
  "Resultados": "Resultados",
  "Detalhes": "Detalles",
  "Ações": "Acciones",
  "Ação": "Acción",
  "Operações": "Operaciones",
  "Relatórios": "Informes",
  "Relatório": "Informe",
  "Etapa anterior": "Etapa anterior",
  "Próxima etapa": "Siguiente etapa",
  "Inspecionar": "Inspeccionar",
  "Conferido": "Verificado",
  "Não conferido": "No verificado",
  "Em espera": "En espera",
  "Pausa": "Pausa",
  "Finalização": "Finalización",
  "Turno": "Turno",
  "Área": "Área",
  "Localização": "Ubicación",
  "Separação": "Separación",
  "Separar": "Separar",
  "Contagem": "Conteo",
  "Contar": "Contar",
  "Revisão": "Revisión",
  "Confirmar Entrada da Estocagem": "Confirmar entrada de Almacenamiento",
  "Somente confirmação.": "Solo confirmación.",
  "Dar Entrada e concluir": "Registrar entrada y finalizar",
  "Entrada confirmada.": "Entrada confirmada.",
  "Nenhuma Entrada confirmada.": "No hay entradas confirmadas.",
  "Não foi possível abrir o endereçamento da Triagem.": "No se pudo abrir la asignación de ubicaciones de Clasificación.",
  "Contagem validada.": "Conteo validado.",
  "Endereçamento obrigatório de saída — ET": "Asignación obligatoria de salida — ET",
  "Contagem validada. Conclua o endereçamento em ET.": "Conteo validado. Complete la asignación de ubicaciones en ET.",
  "Preencha todas as quantidades com inteiros >= 0.": "Ingrese todas las cantidades como números enteros >= 0.",
  "Preencha referência, cor, tamanho e quantidade de cada combinação extra.": "Ingrese referencia, color, talla y cantidad de cada combinación adicional.",
  "Informe se o Card precisa de Etiquetagem.": "Indique si la tarjeta necesita etiquetado.",
  "Nenhuma Entrada pendente. A conferência nasce na conclusão da Estocagem.": "No hay entradas pendientes. La verificación se genera al finalizar el Almacenamiento.",
  "Aqui aparecem somente valores já conferidos e concluídos pela Estocagem. O operador do Processamento confirma a Entrada; o histórico mantém separadamente quem estocou e quem fez a Entrada.": "Aquí aparecen solo las cantidades verificadas y finalizadas por Almacenamiento. El operador de Procesamiento confirma la Entrada; el historial identifica por separado quién almacenó y quién registró la Entrada.",
  "Somente confirmação. As quantidades já foram conferidas na Estocagem. Alterações de grade não são feitas na Entrada.": "Solo confirmación. Las cantidades ya fueron verificadas en Almacenamiento. No se modifican los desgloses por tallas en la Entrada."
});
  const SUPPORTED = Object.freeze(["pt-BR", "es"]);
  let language = "pt-BR";
  const originalText = new WeakMap();
  const originalAttrs = new WeakMap();
  const attributeNames = ["placeholder", "title", "aria-label"];
  const excludedTags = new Set(["SCRIPT","STYLE","NOSCRIPT","TEXTAREA","CODE","PRE","OPTION-INPUT"]);
  let observer = null;
  const pending = new Set();
  let flushScheduled = false;

  function normalizeLanguage(value) {
    return value === "es" ? "es" : "pt-BR";
  }
  function getLanguage() { return language; }
  function lookup(value) {
    if (Object.prototype.hasOwnProperty.call(ES, value)) return ES[value];
    const punctuation = value.match(/^(.+?)([.!?:…]+)$/);
    if (punctuation && Object.prototype.hasOwnProperty.call(ES, punctuation[1]))
      return ES[punctuation[1]] + punctuation[2];
    const counted = value.match(/^(\d[\d.,]*)\s+(peças|volumes|caixas pretas|caixas|itens|referências)$/i);
    if (counted && Object.prototype.hasOwnProperty.call(ES, counted[2]))
      return counted[1] + " " + ES[counted[2]];
    const segments = value.split(/(\s+[·—]\s+|:\s+)/);
    if (segments.length > 1) {
      let found = false;
      const translated = segments.map((part) => {
        if (Object.prototype.hasOwnProperty.call(ES, part)) { found = true; return ES[part]; }
        return part;
      }).join("");
      if (found) return translated;
    }
    return value;
  }
  function t(value, locale) {
    if (value == null) return value;
    if (normalizeLanguage(locale || language) !== "es") return String(value);
    const str = String(value);
    const match = str.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return match[1] + lookup(match[2]) + match[3];
  }
  function ignored(element) {
    if (!element) return true;
    if (excludedTags.has(element.tagName) || element.isContentEditable) return true;
    return !!(element.closest && element.closest("[data-i18n-ignore], [contenteditable='true']"));
  }
  function translateTextNode(node) {
    const parent = node.parentElement;
    if (!parent || ignored(parent) || !node.nodeValue || !node.nodeValue.trim()) return;
    const existing = originalText.get(node);
    const entry = (!existing || node.nodeValue !== existing.last)
      ? {source: node.nodeValue, last: node.nodeValue} : existing;
    const value = t(entry.source);
    if (node.nodeValue !== value) node.nodeValue = value;
    entry.last = value;
    originalText.set(node, entry);
  }
  function translateAttributes(element) {
    if (ignored(element)) return;
    const stored = originalAttrs.get(element) || {};
    for (const name of attributeNames) {
      if (!element.hasAttribute(name)) continue;
      const current = element.getAttribute(name);
      const prior = stored[name];
      const entry = (!prior || current !== prior.last)
        ? {source: current, last: current} : prior;
      const value = t(entry.source);
      if (current !== value) element.setAttribute(name, value);
      entry.last = value;
      stored[name] = entry;
    }
    originalAttrs.set(element, stored);
  }
  function translateNode(node) {
    if (!node) return;
    if (node.nodeType === 3) { translateTextNode(node); return; }
    if (node.nodeType !== 1 || ignored(node)) return;
    translateAttributes(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const child = walker.currentNode;
      if (child.nodeType === 3) translateTextNode(child);
      else translateAttributes(child);
    }
  }
  function flush() {
    flushScheduled = false;
    const nodes = Array.from(pending);
    pending.clear();
    for (const node of nodes) if (node.isConnected) translateNode(node);
  }
  function onChange(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") pending.add(mutation.target);
      else for (const node of mutation.addedNodes) pending.add(node);
    }
    if (!flushScheduled && pending.size) {
      flushScheduled = true;
      Promise.resolve().then(flush);
    }
  }
  function translateDocument() {
    if (typeof document !== "undefined" && document.documentElement)
      translateNode(document.documentElement);
  }
  function setLanguage(next) {
    language = normalizeLanguage(next);
    if (typeof document !== "undefined") {
      document.documentElement.lang = language;
      translateDocument();
      const account = document.getElementById("userLanguage");
      if (account) account.value = language;
      const login = document.getElementById("loginLanguage");
      if (login) login.value = language;
    }
    return language;
  }
  function init() {
    if (typeof document === "undefined" || !document.body || observer) return;
    observer = new MutationObserver(onChange);
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: attributeNames
    });
    translateDocument();
  }
  const api = Object.freeze({t, getLanguage, setLanguage, normalizeLanguage, translateDocument,
    init, catalog: ES, supported: SUPPORTED});
  root.DISTRILOG_I18N = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", init, {once:true});
    else init();
  }
})(typeof window !== "undefined" ? window : globalThis);
