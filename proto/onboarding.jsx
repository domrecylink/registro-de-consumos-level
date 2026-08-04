// Onboarding wizard — create a new consumption tracking project
// 3 steps: Sucursales → Ítems a registrar → Resumen

// ---- Constants ----
const OB_STEP_LABELS = ["Sucursales", "Ítems a registrar", "Resumen"];

const OB_SISTEMAS = [
  { value: "SEN", label: "SEN" },
  { value: "loslagos", label: "Los Lagos" },
  { value: "aysen", label: "Aysén" },
  { value: "magallanes", label: "Magallanes" },
];

const OB_PROVEEDORES = {
  electricidad: [
    "CGE", "Enel", "Chilquinta", "Grupo Saesa", "Edelmag",
  ],
  combustible: [
    "Copec", "Shell", "Petrobras", "Esmax", "Enex", "YPF",
    "Iconstruye Petróleo",
    "Lipigas", "Abastible", "Gasco",
    "Metrogas", "Gasvalpo",
  ],
  agua: [
    "Aguas Andinas", "SMAPA", "Esval", "Essbio",
    "Aguas del Altiplano", "Aguas Antofagasta", "Aguas del Valle",
    "Aguas Araucanía", "Suralis", "Aguas Magallanes",
  ],
  refrigerantes: ["Chemours", "Honeywell", "Daikin", "Linde", "Arkema", "Koura"],
};

const OB_TIPOS_COMBUSTIBLE = [
  { value: "diesel",         label: "Petróleo Diésel",  defaultUnit: "L" },
  { value: "kerosene",       label: "Kerosene",         defaultUnit: "L" },
  { value: "gasolina",       label: "Gasolina",         defaultUnit: "L" },
  { value: "fuel-oil",       label: "Fuel Oil",         defaultUnit: "L" },
  { value: "glp",            label: "GLP",              defaultUnit: "kg" },
  { value: "lena",           label: "Leña",             defaultUnit: "kg" },
  { value: "pellets",        label: "Pellets",          defaultUnit: "kg" },
  { value: "astillas",       label: "Astillas",         defaultUnit: "kg" },
  { value: "carbon-vegetal", label: "Carbón vegetal",    defaultUnit: "kg" },
  { value: "briquetas",      label: "Briquetas",        defaultUnit: "kg" },
  { value: "gas-natural",    label: "Gas Natural",      defaultUnit: "m³" },
  { value: "__otro",         label: "Otro…" },
];

const OB_USOS_COMBUSTIBLE = [
  { value: "estacionario", label: "Estacionario" },
  { value: "movil", label: "Móvil" },
];

const OB_UNIDADES_COMBUSTIBLE = [
  { value: "L",   label: "Litros (L)" },
  { value: "kg",  label: "Kilogramos (kg)" },
  { value: "m³",  label: "Metros cúbicos (m³)" },
  { value: "gal", label: "Galones (gal)" },
  { value: "t",   label: "Toneladas (t)" },
  { value: "kWh", label: "Kilovatios hora (kWh)" },
];

const OB_TIPOS_REFRIGERANTE = [
  { value: "R507", label: "R507" },
  { value: "R407A", label: "R407A" },
  { value: "__otro", label: "Otro" },
];

const OB_TIPOS_AGUA = [
  { value: "potable",    label: "Potable" },
  { value: "gris",       label: "Gris" },
  { value: "industrial", label: "Industrial" },
  { value: "__otro",     label: "Otro…" },
];

const OB_ITEM_DEFS = {
  electricidad:  { label: "Electricidad",  icon: "bolt",              color: "var(--rl-primary-900)", bg: "var(--rl-primary-50)" },
  combustible:   { label: "Combustible",   icon: "local_gas_station", color: "var(--rl-fuel)",        bg: "var(--rl-fuel-bg)" },
  agua:          { label: "Agua",          icon: "water_drop",        color: "var(--rl-success-700)", bg: "var(--rl-success-50)" },
  refrigerantes: { label: "Refrigerantes", icon: "snowflake",         color: "#0891B2",               bg: "#ECFEFF" },
};

// ---- Helpers ----
// ID único global (no un contador por carga, que hacía colisionar "ob1" entre
// usuarios/recargas y se pisaban al guardar por ID).
let _obId = 0;
const obUid = () =>
  "ob_" + Date.now().toString(36) + "_" + (++_obId) +
  Math.random().toString(36).slice(2, 6);
const mkSuc = () => ({ id: obUid(), nombre: "", direccion: "" });

const mkItemsForSuc = () => ({
  electricidad:  { activo: false, subcats: [] },
  combustible:   { activo: false, subcats: [] },
  agua:          { activo: false, subcats: [] },
  refrigerantes: { activo: false, subcats: [] },
});

const mkElecSubcat = () => ({ id: obUid(), sistemaElectrico: "", proveedor: "", proveedorCustom: "", numCliente: "" });
const mkCombSubcat = () => ({ id: obUid(), tipo: "", tipoCustom: "", uso: "", unidad: "", proveedor: "", proveedorCustom: "", numCliente: "" });
const mkAguaSubcat = () => ({ id: obUid(), tipo: "", tipoCustom: "", proveedor: "", proveedorCustom: "", numCliente: "" });
const mkRefriSubcat = () => ({ id: obUid(), tipo: "", tipoCustom: "", proveedor: "", proveedorCustom: "" });

const mkSubcatFor = (type) => {
  if (type === "electricidad") return mkElecSubcat();
  if (type === "combustible") return mkCombSubcat();
  if (type === "agua") return mkAguaSubcat();
  return mkRefriSubcat();
};

const providerOpts = (type) => [
  ...OB_PROVEEDORES[type].map(p => ({ value: p, label: p })),
  { value: "__otro", label: "Otro" },
];

const sistemaLabel = (v) => (OB_SISTEMAS.find(s => s.value === v) || {}).label || v;
const tipoComLabel = (v, custom) => v === "__otro" ? (custom || "Otro") : (OB_TIPOS_COMBUSTIBLE.find(s => s.value === v) || {}).label || v;
const usoLabel = (v) => (OB_USOS_COMBUSTIBLE.find(s => s.value === v) || {}).label || v;
const unidadLabel = (v) => (OB_UNIDADES_COMBUSTIBLE.find(s => s.value === v) || {}).label || v;
const tipoRefriLabel = (v) => v === "__otro" ? "Otro" : (OB_TIPOS_REFRIGERANTE.find(s => s.value === v) || {}).label || v;
const tipoAguaLabel = (v, custom) => v === "__otro" ? (custom || "Otro") : (OB_TIPOS_AGUA.find(s => s.value === v) || {}).label || v;
const proveedorDisplay = (p, c) => p === "__otro" ? (c || "Proveedor personalizado") : (p || "—");

// Fuel unit helpers — available units and default for a given tipo
function fuelUnitsForTipo(tipo) {
  if (!tipo || tipo === "__otro") return OB_UNIDADES_COMBUSTIBLE;
  const cat = FUEL_SUBCATS_CATALOG[tipo];
  if (!cat) return OB_UNIDADES_COMBUSTIBLE;
  return OB_UNIDADES_COMBUSTIBLE.filter(u => cat.units.includes(u.value));
}
function fuelDefaultUnit(tipo) {
  if (!tipo || tipo === "__otro") return "";
  const cat = FUEL_SUBCATS_CATALOG[tipo];
  return cat ? cat.defaultUnit : "";
}

// ---- Wizard shell ----
const OnboardingView = () => {
  const { dispatch } = useApp();
  const [step, setStep] = React.useState(0);
  const [sucursales, setSucursales] = React.useState([mkSuc()]);
  const [items, setItems] = React.useState({});
  const [errors, setErrors] = React.useState({});

  // Sync items when entering step 1+
  React.useEffect(() => {
    if (step >= 1) {
      setItems(prev => {
        const next = {};
        sucursales.forEach(s => { next[s.id] = prev[s.id] || mkItemsForSuc(); });
        return next;
      });
    }
  }, [step, sucursales.length]);

  const validate = () => {
    const e = {};
    if (step === 0) {
      sucursales.forEach(s => {
        if (!s.nombre.trim()) e["suc_" + s.id + "_nombre"] = "Requerido";
      });
    }
    if (step === 1) {
      const anyActive = sucursales.some(s => {
        const si = items[s.id];
        return si && (si.electricidad.activo || si.combustible.activo || si.agua.activo || si.refrigerantes.activo);
      });
      if (!anyActive) e._items = "Activa al menos un ítem en alguna sucursal";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const goNext = () => { if (validate()) setStep(s => Math.min(s + 1, 2)); };
  const goBack = () => { setErrors({}); setStep(s => Math.max(s - 1, 0)); };

  const handleCreate = () => {
    dispatch({ type: "CONFIG/CREATE_PROJECT", sucursales, items });
    // Persistencia en la acción (el observador de configSucursales se eliminó).
    // Se replica la misma forma que arma el reducer para CREATE_PROJECT, así lo
    // que se guarda en el Sheet coincide con lo que queda en el estado.
    const emptyItems = {
      electricidad:  { activo: false, subcats: [] },
      combustible:   { activo: false, subcats: [] },
      agua:          { activo: false, subcats: [] },
      refrigerantes: { activo: false, subcats: [] },
    };
    sucursales.forEach(s => {
      rcSaveSucursal({
        id: s.id,
        nombre: (s.nombre || "").trim(),
        direccion: s.direccion || "",
        activa: true,
        items: items[s.id] || emptyItems,
      });
    });
    dispatch({ type: "NAVIGATE", view: "landing" });
    dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Proyecto creado con éxito", body: sucursales.length + " sucursal" + (sucursales.length !== 1 ? "es" : "") + " configurada" + (sucursales.length !== 1 ? "s" : "") } });
  };

  const updateItem = (sucId, type, patch) => {
    setItems(prev => ({
      ...prev,
      [sucId]: { ...prev[sucId], [type]: { ...prev[sucId][type], ...patch } }
    }));
  };

  const stepMeta = [
    { title: "Sucursales", sub: "Agrega las ubicaciones donde se registrarán consumos." },
    { title: "Ítems a registrar", sub: "Activa los consumos que quieres registrar en cada sucursal y configura sus proveedores." },
    { title: "Resumen del proyecto", sub: "Revisa que todo esté correcto antes de crear el proyecto." },
  ];

  return (
    <div className="ob-wizard">
      <Steps items={OB_STEP_LABELS} current={step} />
      <SectionHead title={stepMeta[step].title} sub={stepMeta[step].sub} />
      <div className="ob-body">
        {step === 0 && <Step1Sucursales sucursales={sucursales} setSucursales={setSucursales} errors={errors} />}
        {step === 1 && <Step2Items sucursales={sucursales} items={items} updateItem={updateItem} setItems={setItems} errors={errors} />}
        {step === 2 && <Step3Resumen sucursales={sucursales} items={items} />}
      </div>
      {errors._items && (
        <div className="prt-help error" style={{ justifyContent: "center" }}>
          <Icon name="error" size={14} /><span>{errors._items}</span>
        </div>
      )}
      <div className="ob-footer">
        {step > 0 ? <Btn onClick={goBack} icon="arrow_back">Atrás</Btn> : <div></div>}
        <div style={{ flex: 1 }}></div>
        {step < 2 ? (
          <Btn kind="primary" onClick={goNext} iconRight="arrow_forward">Siguiente</Btn>
        ) : (
          <Btn kind="primary" onClick={handleCreate} icon="check">Crear proyecto</Btn>
        )}
      </div>
    </div>
  );
};

// ---- Step 1: Sucursales (no sistema eléctrico here) ----
const Step1Sucursales = ({ sucursales, setSucursales, errors }) => {
  const update = (id, patch) => setSucursales(ss => ss.map(s => s.id === id ? { ...s, ...patch } : s));
  const remove = (id) => setSucursales(ss => ss.filter(s => s.id !== id));
  const add = () => setSucursales(ss => [...ss, mkSuc()]);

  return (
    <div className="prt-stack-md">
      {sucursales.map((s, i) => (
        <div key={s.id} className="ob-suc-card">
          <div className="ob-suc-card-head">
            <span className="ob-suc-num">{i + 1}</span>
            <span className="prt-h4" style={{ flex: 1 }}>{s.nombre || "Sucursal " + (i + 1)}</span>
            {sucursales.length > 1 && (
              <button className="ob-icon-btn" onClick={() => remove(s.id)} title="Eliminar sucursal">
                <Icon name="delete" size={16} />
              </button>
            )}
          </div>
          <div className="ob-suc-card-body">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Field label="Nombre" required error={errors["suc_" + s.id + "_nombre"]}>
                <Input value={s.nombre} onChange={v => update(s.id, { nombre: v })} placeholder="Ej: Planta Norte" error={!!errors["suc_" + s.id + "_nombre"]} />
              </Field>
              <Field label="Dirección">
                <Input value={s.direccion} onChange={v => update(s.id, { direccion: v })} placeholder="Opcional" />
              </Field>
            </div>
          </div>
        </div>
      ))}
      <button className="ob-add-btn" onClick={add}>
        <Icon name="add" size={18} />
        <span>Agregar sucursal</span>
      </button>
    </div>
  );
};

Object.assign(window, {
  OnboardingView, Step1Sucursales,
  OB_STEP_LABELS, OB_SISTEMAS, OB_PROVEEDORES,
  OB_TIPOS_COMBUSTIBLE, OB_USOS_COMBUSTIBLE, OB_UNIDADES_COMBUSTIBLE, OB_TIPOS_REFRIGERANTE, OB_TIPOS_AGUA,
  OB_ITEM_DEFS, obUid, mkSuc, mkItemsForSuc,
  mkElecSubcat, mkCombSubcat, mkAguaSubcat, mkRefriSubcat, mkSubcatFor,
  providerOpts, sistemaLabel,
  tipoComLabel, usoLabel, unidadLabel, tipoRefriLabel, tipoAguaLabel, proveedorDisplay,
  fuelUnitsForTipo, fuelDefaultUnit,
});
