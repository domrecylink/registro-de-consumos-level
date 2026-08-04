// Config Edit — edit a single sucursal (reuses onboarding aesthetics)

const ConfigEditView = () => {
  const { state, dispatch } = useApp();
  // Sucursal existente, o el draft de una nueva (configNewSuc) que aún no
  // está en configSucursales (no persiste hasta confirmar).
  const existing = state.configSucursales.find(s => s.id === state.configEditId);
  const isNew = !existing;
  const original = existing
    || (state.configNewSuc && state.configNewSuc.id === state.configEditId ? state.configNewSuc : null);
  if (!original) return null;

  const [draft, setDraft] = React.useState(JSON.parse(JSON.stringify(original)));
  const [errors, setErrors] = React.useState({});
  const [confirmModal, setConfirmModal] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  const updateDraft = (patch) => setDraft(d => ({ ...d, ...patch }));
  const updateItem = (type, patch) => {
    setDraft(d => ({
      ...d,
      items: { ...d.items, [type]: { ...d.items[type], ...patch } },
    }));
  };

  const toggleItem = (type) => {
    const current = draft.items[type];
    const patch = { activo: !current.activo };
    if (!current.activo && current.subcats.length === 0) {
      patch.subcats = [mkSubcatFor(type)];
    }
    updateItem(type, patch);
  };

  const addSubcat = (type) => {
    const item = draft.items[type];
    updateItem(type, { subcats: [...item.subcats, mkSubcatFor(type)] });
  };

  const updateSubcat = (type, subId, patch) => {
    const item = draft.items[type];
    updateItem(type, { subcats: item.subcats.map(sc => sc.id === subId ? { ...sc, ...patch } : sc) });
  };

  const removeSubcatCheck = (type, subId) => {
    // Check if item has records
    const recCount = state.records.filter(r => r.sucursal === original.nombre && r.type === type).length;
    if (recCount > 0 && draft.items[type].subcats.length === 1) {
      // Last subcat with records
      setConfirmModal({ type: "delete-last-item", itemType: type, subId, recCount });
    } else if (recCount > 0) {
      setConfirmModal({ type: "delete-item-records", itemType: type, subId, recCount });
    } else {
      doRemoveSubcat(type, subId);
    }
  };

  const doRemoveSubcat = (type, subId) => {
    const item = draft.items[type];
    const remaining = item.subcats.filter(sc => sc.id !== subId);
    if (remaining.length === 0) {
      updateItem(type, { activo: false, subcats: [] });
    } else {
      updateItem(type, { subcats: remaining });
    }
    setConfirmModal(null);
  };

  const validate = () => {
    const e = {};
    if (!draft.nombre.trim()) e.nombre = "El nombre es requerido";
    // duplicate name
    const dup = state.configSucursales.find(s => s.id !== draft.id && s.nombre.trim().toLowerCase() === draft.nombre.trim().toLowerCase());
    if (dup) e.nombre = "Ya existe una sucursal con este nombre";
    // at least one item
    const anyActive = ["electricidad","combustible","agua","refrigerantes"].some(t => draft.items[t].activo);
    if (!anyActive) e._items = "Una sucursal debe tener al menos un ítem de consumo configurado";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    // La validación de arriba mira la lista local, que puede estar desfasada:
    // otro usuario pudo crear una sucursal con este nombre después de que
    // cargamos. Los registros se vinculan a la sucursal por NOMBRE, así que dos
    // con el mismo nombre dejan el lookup ambiguo. Revalidamos contra el Sheet.
    setSaving(true);
    try {
      const fresh = await rcReadConfigSucursales();
      const target = draft.nombre.trim().toLowerCase();
      const dup = (fresh || []).find(
        s => s.id !== draft.id && String(s.nombre || "").trim().toLowerCase() === target
      );
      if (dup) {
        setErrors(e => ({ ...e, nombre: "Otro usuario ya creó una sucursal con este nombre" }));
        return;
      }
    } catch (e) {
      // Sin conexión al Sheet seguimos con la validación local; el upsert es
      // por ID, así que en el peor caso queda un nombre repetido, no pérdida.
      console.warn("[config-edit] no se pudo revalidar el nombre contra el Sheet", e);
    } finally {
      setSaving(false);
    }
    // Sucursal nueva: no hay historial que renombrar/recalcular → guarda directo.
    if (isNew) { doSave(); return; }
    const nameChanged = draft.nombre.trim() !== original.nombre;
    const sistemaChanged = hasSistemaChanged();
    if (nameChanged) {
      setConfirmModal({ type: "rename", oldName: original.nombre, newName: draft.nombre.trim() });
    } else if (sistemaChanged) {
      setConfirmModal({ type: "sistema-changed" });
    } else {
      doSave();
    }
  };

  const hasSistemaChanged = () => {
    const origElec = original.items.electricidad;
    const draftElec = draft.items.electricidad;
    if (!origElec.activo || !draftElec.activo) return false;
    const origSistemas = origElec.subcats.map(sc => sc.sistemaElectrico).sort().join(",");
    const draftSistemas = draftElec.subcats.map(sc => sc.sistemaElectrico).sort().join(",");
    return origSistemas !== draftSistemas;
  };

  const doSave = (renameHistory, recalcEmissions) => {
    if (renameHistory) {
      dispatch({ type: "CONFIG/RENAME_HISTORY", oldName: original.nombre, newName: draft.nombre.trim() });
    }
    const suc = { ...draft, nombre: draft.nombre.trim() };
    dispatch({ type: "CONFIG/SAVE_SUC", suc });
    // Persistencia en la acción, no por observador de estado: así una carga de
    // la app nunca puede disparar una escritura al Sheet.
    rcSaveSucursal(suc);
    dispatch({ type: "TOAST/SHOW", toast: {
      kind: "success",
      title: isNew ? "Sucursal creada" : "Cambios guardados",
      body: isNew
        ? `"${draft.nombre.trim()}" fue creada correctamente.`
        : `"${draft.nombre.trim()}" actualizada correctamente.${recalcEmissions ? " Emisiones recalculadas." : ""}`,
    }});
    setConfirmModal(null);
  };

  const handleCancel = () => {
    // Descarta el draft de sucursal nueva (no persiste); en edición solo vuelve.
    dispatch({ type: "CONFIG/CANCEL_EDIT" });
  };

  return (
    <div>
      <SectionHead
        eyebrow={isNew ? "Configuración / Sucursales / Nueva" : `Configuración / Sucursales / ${original.nombre}`}
        title={isNew ? `Nueva sucursal${draft.nombre ? ": " + draft.nombre : ""}` : `Editar: ${draft.nombre || "Sin nombre"}`}
        right={
          <Btn icon="arrow_back" onClick={handleCancel}>{isNew ? "Cancelar" : "Volver a configuración"}</Btn>
        }
      />

      {/* General data */}
      <Card style={{ marginBottom: 20 }}>
        <div className="prt-h4" style={{ marginBottom: 14 }}>Datos generales</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label="Nombre de la sucursal" required error={errors.nombre}>
            <Input value={draft.nombre} onChange={v => updateDraft({ nombre: v })} placeholder="Ej: Planta Norte" error={!!errors.nombre} />
          </Field>
          <Field label="Dirección">
            <Input value={draft.direccion} onChange={v => updateDraft({ direccion: v })} placeholder="Opcional" />
          </Field>
        </div>
      </Card>

      {/* Items */}
      <Card style={{ marginBottom: 20 }}>
        <div className="prt-h4" style={{ marginBottom: 4 }}>Ítems de consumo</div>
        <div className="prt-hint" style={{ marginBottom: 16 }}>Activa los consumos que quieres registrar y configura sus proveedores.</div>

        {errors._items && (
          <div className="prt-help error" style={{ justifyContent: "center", marginBottom: 14 }}>
            <Icon name="error" size={14} /><span>{errors._items}</span>
          </div>
        )}

        <div className="prt-stack-md">
          {["electricidad","combustible","agua","refrigerantes"].map(type => {
            const def = OB_ITEM_DEFS[type];
            const item = draft.items[type];
            return (
              <div key={type} className={"ob-item-card" + (item.activo ? " active" : "")}>
                <div className="ob-item-head" onClick={() => toggleItem(type)}>
                  <span className="ob-item-ico" style={{ background: def.bg, color: def.color }}>
                    <Icon name={def.icon} size={20} />
                  </span>
                  <span className="ob-item-label">{def.label}</span>
                  <button
                    className={"ob-toggle" + (item.activo ? " active" : "")}
                    onClick={e => { e.stopPropagation(); toggleItem(type); }}
                  ></button>
                </div>
                {item.activo && (
                  <div className="ob-item-body">
                    {type === "electricidad" && (
                      <ConfigElecForm item={item}
                        onUpdate={(subId, patch) => updateSubcat(type, subId, patch)}
                        onAdd={() => addSubcat(type)}
                        onRemove={(subId) => removeSubcatCheck(type, subId)} />
                    )}
                    {type === "combustible" && (
                      <ConfigCombForm item={item}
                        onUpdate={(subId, patch) => updateSubcat(type, subId, patch)}
                        onAdd={() => addSubcat(type)}
                        onRemove={(subId) => removeSubcatCheck(type, subId)} />
                    )}
                    {type === "agua" && (
                      <ConfigAguaForm item={item}
                        onUpdate={(subId, patch) => updateSubcat(type, subId, patch)}
                        onAdd={() => addSubcat(type)}
                        onRemove={(subId) => removeSubcatCheck(type, subId)} />
                    )}
                    {type === "refrigerantes" && (
                      <ConfigRefriForm item={item}
                        onUpdate={(subId, patch) => updateSubcat(type, subId, patch)}
                        onAdd={() => addSubcat(type)}
                        onRemove={(subId) => removeSubcatCheck(type, subId)} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Footer actions */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingBottom: 80 }}>
        <Btn onClick={handleCancel} disabled={saving}>Cancelar</Btn>
        <Btn kind="primary" icon="check" onClick={handleSave} disabled={saving}>
          {saving ? "Verificando…" : "Guardar cambios"}
        </Btn>
      </div>

      {/* ---- Confirmation modals ---- */}

      {/* Rename */}
      {confirmModal?.type === "rename" && (
        <ConfirmDialog
          icon="edit" iconBg="var(--rl-primary-50)" iconColor="var(--rl-primary-900)"
          title="Nombre de sucursal modificado"
          description={`Cambiaste el nombre de "${confirmModal.oldName}" a "${confirmModal.newName}". ¿Quieres actualizar también los registros históricos con este nuevo nombre?`}
          actions={<>
            <Btn onClick={() => {
              // Check if sistema also changed
              if (hasSistemaChanged()) {
                setConfirmModal({ type: "sistema-changed", afterRename: false });
              } else {
                doSave(false);
              }
            }}>No, solo desde ahora</Btn>
            <Btn kind="primary" onClick={() => {
              if (hasSistemaChanged()) {
                setConfirmModal({ type: "sistema-changed", afterRename: true });
              } else {
                doSave(true);
              }
            }}>Sí, actualizar todo</Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}

      {/* Sistema eléctrico changed */}
      {confirmModal?.type === "sistema-changed" && (
        <ConfirmDialog
          icon="bolt" iconBg="var(--rl-warning-50)" iconColor="var(--rl-warning-600)"
          title="Sistema eléctrico modificado"
          description="Cambiaste el sistema eléctrico. ¿Quieres recalcular las emisiones de los registros históricos con el nuevo factor?"
          actions={<>
            <Btn onClick={() => doSave(confirmModal.afterRename, false)}>No, aplicar solo a nuevos registros</Btn>
            <Btn kind="primary" onClick={() => doSave(confirmModal.afterRename, true)}>Sí, recalcular</Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}

      {/* Delete item with records */}
      {confirmModal?.type === "delete-item-records" && (
        <ConfirmDialog
          icon="delete" iconBg="var(--rl-error-50)" iconColor="var(--rl-error-500)"
          title="Este ítem tiene operaciones registradas"
          description={`Este ítem tiene ${confirmModal.recCount} operaciones registradas. ¿Qué deseas hacer?`}
          actions={<>
            <Btn onClick={() => setConfirmModal(null)}>Cancelar</Btn>
            <Btn onClick={() => doRemoveSubcat(confirmModal.itemType, confirmModal.subId)}>
              Mantener operaciones
            </Btn>
            <Btn kind="danger" onClick={() => doRemoveSubcat(confirmModal.itemType, confirmModal.subId)}>
              Eliminar también operaciones
            </Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}

      {/* Delete last item */}
      {confirmModal?.type === "delete-last-item" && (
        <ConfirmDialog
          icon="warning" iconBg="var(--rl-warning-50)" iconColor="var(--rl-warning-600)"
          title="Última subcategoría con operaciones"
          description={`Este ítem tiene operaciones aún registradas (${confirmModal.recCount}). ¿Deseas eliminar definitivamente o volver para revisarlas primero?`}
          actions={<>
            <Btn onClick={() => setConfirmModal(null)}>Volver para revisar</Btn>
            <Btn kind="danger" onClick={() => doRemoveSubcat(confirmModal.itemType, confirmModal.subId)}>
              Eliminar definitivamente
            </Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
};

// ---- Item sub-forms (reuse onboarding patterns) ----
const ConfigElecForm = ({ item, onUpdate, onAdd, onRemove }) => (
  <div className="prt-stack-md">
    {item.subcats.map((sc, i) => (
      <div key={sc.id} className="ob-subcat-block">
        <div className="ob-subcat-head">
          <span className="prt-hint" style={{ fontWeight: 700 }}>Subcategoría {i + 1}</span>
          {item.subcats.length > 1 && (
            <button className="ob-icon-btn sm" onClick={() => onRemove(sc.id)} title="Eliminar"><Icon name="close" size={14} /></button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label={<span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>Sistema eléctrico<span className="req">*</span>
            <span className="ob-tooltip-wrap"><Icon name="info" size={13} style={{ color: "var(--rl-gray-400)" }} /><span className="ob-tooltip">Determina el factor de emisión</span></span>
          </span>}>
            <Select value={sc.sistemaElectrico} onChange={v => onUpdate(sc.id, { sistemaElectrico: v })} options={OB_SISTEMAS} placeholder="Seleccionar…" />
          </Field>
          <Field label="Proveedor">
            <Select value={sc.proveedor} onChange={v => onUpdate(sc.id, { proveedor: v })} options={providerOpts("electricidad")} placeholder="Seleccionar…" />
          </Field>
          {sc.proveedor === "__otro" && (
            <Field label="Nombre del proveedor">
              <Input value={sc.proveedorCustom} onChange={v => onUpdate(sc.id, { proveedorCustom: v })} placeholder="Ingresa el nombre…" />
            </Field>
          )}
          <Field label="N° de cliente" helper="Match automático con facturas">
            <Input value={sc.numCliente} onChange={v => onUpdate(sc.id, { numCliente: v })} placeholder="Opcional" />
          </Field>
        </div>
      </div>
    ))}
    <button className="ob-add-btn sm" onClick={onAdd}><Icon name="add" size={16} /><span>Agregar subcategoría</span></button>
  </div>
);

const ConfigCombForm = ({ item, onUpdate, onAdd, onRemove }) => (
  <div className="prt-stack-md">
    {item.subcats.map((sc, i) => (
      <div key={sc.id} className="ob-subcat-block">
        <div className="ob-subcat-head">
          <span className="prt-hint" style={{ fontWeight: 700 }}>Subcategoría {i + 1}</span>
          {item.subcats.length > 1 && (
            <button className="ob-icon-btn sm" onClick={() => onRemove(sc.id)} title="Eliminar"><Icon name="close" size={14} /></button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Tipo" required>
            <Select value={sc.tipo} onChange={v => {
              const defUnit = fuelDefaultUnit(v);
              onUpdate(sc.id, { tipo: v, ...(defUnit ? { unidad: defUnit } : {}) });
            }} options={OB_TIPOS_COMBUSTIBLE.map(t => ({
              value: t.value,
              label: t.defaultUnit ? `${t.label} · ${t.defaultUnit}` : t.label,
            }))} placeholder="Seleccionar…" />
          </Field>
          {sc.tipo === "__otro" && (
            <Field label="Nombre del combustible">
              <Input value={sc.tipoCustom || ""} onChange={v => onUpdate(sc.id, { tipoCustom: v })} placeholder="Ej: Biogás" />
            </Field>
          )}
          <Field label={<span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>Uso<span className="req">*</span>
            <span className="ob-tooltip-wrap"><Icon name="info" size={13} style={{ color: "var(--rl-gray-400)" }} /><span className="ob-tooltip">Afecta el factor de emisión</span></span>
          </span>}>
            <Select value={sc.uso} onChange={v => onUpdate(sc.id, { uso: v })} options={OB_USOS_COMBUSTIBLE} placeholder="Seleccionar…" />
          </Field>
          <Field label={sc.tipo && fuelDefaultUnit(sc.tipo)
            ? <span>Unidad de medida <span className="prt-hint" style={{ fontWeight: 400 }}>(pred: {fuelDefaultUnit(sc.tipo)})</span></span>
            : "Unidad de medida"}>
            <Select value={sc.unidad} onChange={v => onUpdate(sc.id, { unidad: v })} options={fuelUnitsForTipo(sc.tipo)} placeholder="Seleccionar…" />
          </Field>
          <Field label="Proveedor">
            <Select value={sc.proveedor} onChange={v => onUpdate(sc.id, { proveedor: v })} options={providerOpts("combustible")} placeholder="Seleccionar…" />
          </Field>
          {sc.proveedor === "__otro" && (
            <Field label="Nombre del proveedor">
              <Input value={sc.proveedorCustom} onChange={v => onUpdate(sc.id, { proveedorCustom: v })} placeholder="Nombre…" />
            </Field>
          )}
          <Field label="N° de cliente" helper="Match automático con facturas">
            <Input value={sc.numCliente} onChange={v => onUpdate(sc.id, { numCliente: v })} placeholder="Opcional" />
          </Field>
        </div>
      </div>
    ))}
    <button className="ob-add-btn sm" onClick={onAdd}><Icon name="add" size={16} /><span>Agregar subcategoría</span></button>
  </div>
);

const ConfigAguaForm = ({ item, onUpdate, onAdd, onRemove }) => (
  <div className="prt-stack-md">
    {item.subcats.map((sc, i) => (
      <div key={sc.id} className="ob-subcat-block">
        <div className="ob-subcat-head">
          <span className="prt-hint" style={{ fontWeight: 700 }}>Subcategoría {i + 1}</span>
          {item.subcats.length > 1 && (
            <button className="ob-icon-btn sm" onClick={() => onRemove(sc.id)} title="Eliminar"><Icon name="close" size={14} /></button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Tipo de agua" required>
            <Select value={sc.tipo} onChange={v => onUpdate(sc.id, { tipo: v })} options={OB_TIPOS_AGUA} placeholder="Seleccionar…" />
          </Field>
          {sc.tipo === "__otro" && (
            <Field label="Nombre del tipo">
              <Input value={sc.tipoCustom || ""} onChange={v => onUpdate(sc.id, { tipoCustom: v })} placeholder="Ej: Riego" />
            </Field>
          )}
          <Field label="Proveedor">
            <Select value={sc.proveedor} onChange={v => onUpdate(sc.id, { proveedor: v })} options={providerOpts("agua")} placeholder="Seleccionar…" />
          </Field>
          {sc.proveedor === "__otro" && (
            <Field label="Nombre del proveedor">
              <Input value={sc.proveedorCustom} onChange={v => onUpdate(sc.id, { proveedorCustom: v })} placeholder="Ingresa el nombre…" />
            </Field>
          )}
          <Field label="N° de cliente" helper="Match automático con facturas">
            <Input value={sc.numCliente} onChange={v => onUpdate(sc.id, { numCliente: v })} placeholder="Opcional" />
          </Field>
        </div>
      </div>
    ))}
    <button className="ob-add-btn sm" onClick={onAdd}><Icon name="add" size={16} /><span>Agregar subcategoría</span></button>
  </div>
);

const ConfigRefriForm = ({ item, onUpdate, onAdd, onRemove }) => (
  <div className="prt-stack-md">
    {item.subcats.map((sc, i) => (
      <div key={sc.id} className="ob-subcat-block">
        <div className="ob-subcat-head">
          <span className="prt-hint" style={{ fontWeight: 700 }}>Subcategoría {i + 1}</span>
          {item.subcats.length > 1 && (
            <button className="ob-icon-btn sm" onClick={() => onRemove(sc.id)} title="Eliminar"><Icon name="close" size={14} /></button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Tipo de refrigerante" required>
            <Select value={sc.tipo} onChange={v => onUpdate(sc.id, { tipo: v })} options={OB_TIPOS_REFRIGERANTE} placeholder="Seleccionar…" />
          </Field>
          {sc.tipo === "__otro" && (
            <Field label="Nombre del refrigerante">
              <Input value={sc.tipoCustom || ""} onChange={v => onUpdate(sc.id, { tipoCustom: v })} placeholder="Ej: R-32" />
            </Field>
          )}
          <Field label="Proveedor">
            <Select value={sc.proveedor} onChange={v => onUpdate(sc.id, { proveedor: v })} options={providerOpts("refrigerantes")} placeholder="Opcional" />
          </Field>
          {sc.proveedor === "__otro" && (
            <Field label="Nombre del proveedor">
              <Input value={sc.proveedorCustom} onChange={v => onUpdate(sc.id, { proveedorCustom: v })} placeholder="Nombre…" />
            </Field>
          )}
        </div>
      </div>
    ))}
    <button className="ob-add-btn sm" onClick={onAdd}><Icon name="add" size={16} /><span>Agregar subcategoría</span></button>
  </div>
);

Object.assign(window, { ConfigEditView, ConfigElecForm, ConfigCombForm, ConfigAguaForm, ConfigRefriForm });
