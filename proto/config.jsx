// Configuración — sucursales list + confirmation modals

const ConfigView = () => {
  const { state, dispatch } = useApp();
  const sucs = state.configSucursales;
  const [confirmModal, setConfirmModal] = React.useState(null); // { type, suc }

  const countItems = (suc) =>
    ["electricidad","combustible","agua","refrigerantes"].filter(t => suc.items[t].activo).length;

  const sistemaFor = (suc) => {
    const elec = suc.items.electricidad;
    if (!elec.activo || elec.subcats.length === 0) return "—";
    const sistemas = [...new Set(elec.subcats.map(sc => sc.sistemaElectrico).filter(Boolean))];
    return sistemas.map(s => sistemaLabel(s)).join(", ") || "—";
  };

  const handleToggleActive = (suc) => {
    if (suc.activa) {
      setConfirmModal({ type: "deactivate", suc });
    } else {
      dispatch({ type: "CONFIG/TOGGLE_ACTIVE", id: suc.id });
      // El reducer invierte `activa`; persistimos el resultado en la acción.
      rcSaveSucursal({ ...suc, activa: true });
      dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Sucursal activada", body: `"${suc.nombre}" está disponible para registrar consumos.` } });
    }
  };

  const handleDelete = (suc) => {
    const recCount = state.records.filter(r => r.sucursal === suc.nombre).length;
    setConfirmModal({ type: "delete-suc", suc, recCount });
  };

  const confirmDeactivate = () => {
    dispatch({ type: "CONFIG/TOGGLE_ACTIVE", id: confirmModal.suc.id });
    rcSaveSucursal({ ...confirmModal.suc, activa: false });
    dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Sucursal desactivada", body: `"${confirmModal.suc.nombre}" ya no aparecerá al registrar consumos.` } });
    setConfirmModal(null);
  };

  const confirmDeleteSuc = () => {
    const { id, nombre } = confirmModal.suc;
    dispatch({ type: "CONFIG/DELETE_SUC", id });
    // Borrado explícito del usuario → sí se elimina en el server. Ninguna otra
    // ruta borra sucursales: el guardado automático solo hace upsert por ID.
    rcRemoveSucursal(id);
    dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Sucursal eliminada", body: `"${nombre}" fue eliminada.` } });
    setConfirmModal(null);
  };

  return (
    <div>
      <SectionHead
        eyebrow="Configuración / Sucursales"
        title="Sucursales configuradas"
        right={
          <>
            <Btn kind="primary" icon="add" onClick={() => dispatch({ type: "CONFIG/ADD_SUC" })}>
              Agregar sucursal
            </Btn>
            <Btn icon="arrow_back" onClick={() => dispatch({ type: "NAVIGATE", view: "dashboard" })}>
              Volver al dashboard
            </Btn>
          </>
        }
      />

      <div className="prt-stack-md" style={{ marginBottom: 20 }}>
        {sucs.map(suc => (
          <div key={suc.id} className={"cfg-suc-card" + (!suc.activa ? " inactive" : "")}>
            <div className="cfg-suc-row">
              <div className="cfg-suc-info">
                <div className="cfg-suc-name">{suc.nombre}</div>
                {suc.direccion && <div className="prt-hint" style={{ marginTop: 1 }}>{suc.direccion}</div>}
              </div>
              <Chip kind={suc.activa ? "success" : "neutral"} size="sm">
                {suc.activa ? "Activa" : "Inactiva"}
              </Chip>
              <div className="cfg-suc-meta">
                <span className="cfg-meta-pill">
                  <Icon name="checklist" size={14} />
                  {countItems(suc)} ítem{countItems(suc) !== 1 ? "s" : ""}
                </span>
                <span className="cfg-meta-pill">
                  <Icon name="bolt" size={14} />
                  {sistemaFor(suc)}
                </span>
              </div>
              <div className="cfg-suc-actions">
                <Btn size="sm" icon="edit" onClick={() => dispatch({ type: "CONFIG/EDIT_SUC", id: suc.id })}>
                  Editar
                </Btn>
                <button
                  className={"cfg-toggle-btn" + (suc.activa ? " active" : "")}
                  onClick={() => handleToggleActive(suc)}
                  title={suc.activa ? "Desactivar sucursal" : "Activar sucursal"}
                >
                  <span className="cfg-toggle-track">
                    <span className="cfg-toggle-thumb"></span>
                  </span>
                  <span className="cfg-toggle-label">{suc.activa ? "Activada" : "Desactivada"}</span>
                </button>
                <Btn size="sm" kind="danger" icon="delete" onClick={() => handleDelete(suc)}>
                  Eliminar
                </Btn>
              </div>
            </div>
          </div>
        ))}
      </div>

      <NotifEmailsSection />

      {/* Deactivate confirmation */}
      {confirmModal?.type === "deactivate" && (
        <ConfirmDialog
          icon="toggle_off" iconBg="var(--rl-warning-50)" iconColor="var(--rl-warning-600)"
          title="¿Desactivar esta sucursal?"
          description="Al desactivar esta sucursal ya no aparecerá como opción al registrar consumos, pero su historial se mantiene. ¿Confirmas?"
          actions={<>
            <Btn onClick={() => setConfirmModal(null)}>Cancelar</Btn>
            <Btn kind="primary" onClick={confirmDeactivate}>Sí, desactivar</Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}

      {/* Delete sucursal confirmation */}
      {confirmModal?.type === "delete-suc" && (
        <ConfirmDialog
          icon="delete" iconBg="var(--rl-error-50)" iconColor="var(--rl-error-500)"
          title="¿Eliminar esta sucursal?"
          description={confirmModal.recCount > 0
            ? `"${confirmModal.suc.nombre}" tiene ${confirmModal.recCount} registros históricos. Se eliminará la configuración pero los registros se mantendrán.`
            : `"${confirmModal.suc.nombre}" no tiene registros. Se eliminará completamente.`}
          actions={<>
            <Btn onClick={() => setConfirmModal(null)}>Cancelar</Btn>
            <Btn kind="danger" icon="delete" onClick={confirmDeleteSuc}>Eliminar sucursal</Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
};

// Reusable confirmation dialog
const ConfirmDialog = ({ icon, iconBg, iconColor, title, description, detail, actions, onClose }) => (
  <div className="prt-modal-scrim" onClick={onClose}>
    <div className="prt-confirm-dialog" onClick={e => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
        <span style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: iconBg || "var(--rl-error-50)", color: iconColor || "var(--rl-error-500)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}><Icon name={icon} size={20} /></span>
        <div style={{ flex: 1 }}>
          <div className="prt-h4">{title}</div>
          <div className="prt-hint" style={{ marginTop: 4, lineHeight: 1.5 }}>{description}</div>
        </div>
      </div>
      {detail && (
        <div style={{
          background: "var(--rl-gray-50)", borderRadius: 8, padding: "12px 14px",
          font: "500 13px/1.5 var(--rl-font-body)", color: "var(--rl-gray-700)",
          marginBottom: 20,
        }}>{detail}</div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {actions}
      </div>
    </div>
  </div>
);

// Editor de emails que reciben aviso al subir foto pendiente.
const NotifEmailsSection = () => {
  const { state, dispatch } = useApp();
  const emails = state.fotoNotifEmails || [];
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState("");

  const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!validEmail(v)) { setError("Email inválido."); return; }
    if (emails.indexOf(v) !== -1) { setError("Ya está en la lista."); return; }
    dispatch({ type: "NOTIF/ADD", email: v });
    setDraft("");
    setError("");
  };

  const remove = (e) => dispatch({ type: "NOTIF/REMOVE", email: e });

  return (
    <div style={{ marginTop: 28 }}>
      <SectionHead
        eyebrow="Notificaciones"
        title="Avisos de cola pendiente (Tomar foto)"
        sub="Cada vez que se suba una foto al módulo Tomar foto, estos destinatarios reciben un correo con los datos y el total pendiente."
      />
      <Card>
        <div className="prt-col" style={{ gap: 12 }}>
          <div className="prt-row" style={{ gap: 8, flexWrap: "wrap" }}>
            {emails.length === 0 && (
              <span className="prt-hint">Sin destinatarios — no se enviará correo.</span>
            )}
            {emails.map(e => (
              <Chip key={e} kind="neutral" icon="mail" onClose={() => remove(e)}>{e}</Chip>
            ))}
          </div>
          <div className="prt-row" style={{ gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field error={error}>
                <Input
                  value={draft}
                  onChange={(v) => { setDraft(v); if (error) setError(""); }}
                  placeholder="nombre@empresa.cl"
                  onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } }}
                />
              </Field>
            </div>
            <Btn kind="primary" icon="add" onClick={add} disabled={!draft.trim()}>Agregar</Btn>
          </div>
        </div>
      </Card>
    </div>
  );
};

Object.assign(window, { ConfigView, ConfirmDialog, NotifEmailsSection });
