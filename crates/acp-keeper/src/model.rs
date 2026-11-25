//! What the keeper knows about its session: the session id, the mode and model the agent runs with,
//! whether a turn is running, and the agent requests waiting for an answer. The conversation itself
//! is not kept: people read it in Ovis, and the archive has every line.

use serde_json::{Map, Value};

pub struct Pending {
    pub key: String,
    pub id: Value,
    pub seq: u64,
    pub method: String,
    pub session: Option<String>,
    pub options: Vec<String>,
}

pub struct Selector {
    pub current: String,
    pub options: Vec<(String, String)>,
    pub config_id: Option<String>,
}

impl Selector {
    /// The name of the current choice, or its id when the agent gave no name.
    pub fn current_name(&self) -> &str {
        self.options
            .iter()
            .find(|(id, _)| *id == self.current)
            .map(|(_, name)| name.as_str())
            .filter(|n| !n.is_empty())
            .unwrap_or(&self.current)
    }
}

#[derive(Default)]
pub struct Model {
    pub agent: String,
    pub session: Option<String>,
    pub modes: Option<Selector>,
    pub models: Option<Selector>,
    pub allow_all: bool,
    pub working: bool,
    pub pending: Vec<Pending>,
    pub clients: usize,
    pub agent_gone: Option<String>,
    /// The latest thing worth telling whoever looks at the pane (a refused switch, an error).
    pub notice: Option<String>,
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

impl Model {
    pub fn new(agent: String) -> Model {
        Model { agent, ..Model::default() }
    }

    pub fn note(&mut self, text: impl Into<String>) {
        self.notice = Some(text.into());
    }

    pub fn error(&mut self, text: impl Into<String>) {
        self.notice = Some(format!("✖ {}", text.into()));
    }

    pub fn update(&mut self, params: &Value) {
        if self.session.is_some() && params.get("sessionId").and_then(Value::as_str) != self.session.as_deref() {
            return;
        }
        let Some(update) = params.get("update") else { return };
        match update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("") {
            "current_mode_update" => {
                if let (Some(modes), Some(id)) = (self.modes.as_mut(), str_field(update, "currentModeId")) {
                    modes.current = id;
                }
            }
            "config_option_update" => {
                if let Some(options) = update.get("configOptions") {
                    self.config_options(options);
                }
            }
            _ => {}
        }
    }

    pub fn session_result(&mut self, result: &Value) {
        if let Some(modes) = result.get("modes").filter(|m| m.is_object()) {
            self.modes = Some(Selector {
                current: str_field(modes, "currentModeId").unwrap_or_default(),
                options: modes
                    .get("availableModes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|m| (str_field(m, "id").unwrap_or_default(), str_field(m, "name").unwrap_or_default()))
                    .collect(),
                config_id: None,
            });
        }
        if let Some(models) = result.get("models").filter(|m| m.is_object()) {
            self.models = Some(Selector {
                current: str_field(models, "currentModelId").unwrap_or_default(),
                options: models
                    .get("availableModels")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|m| (str_field(m, "modelId").unwrap_or_default(), str_field(m, "name").unwrap_or_default()))
                    .collect(),
                config_id: None,
            });
        }
        if let Some(options) = result.get("configOptions") {
            self.config_options(options);
        }
    }

    /// Session config options (the newer ACP form) take over the mode and model when they carry those categories.
    pub fn config_options(&mut self, options: &Value) {
        for option in options.as_array().into_iter().flatten() {
            let id = str_field(option, "id").unwrap_or_default();
            if id == "allow_all" {
                self.allow_all = option.get("currentValue").and_then(Value::as_str) != Some("off");
                continue;
            }
            let category = str_field(option, "category").unwrap_or_else(|| id.clone());
            let slot = match category.as_str() {
                "mode" => &mut self.modes,
                "model" => &mut self.models,
                _ => continue,
            };
            let mut choices = vec![];
            for item in option.get("options").and_then(Value::as_array).into_iter().flatten() {
                if let Some(group) = item.get("options").and_then(Value::as_array) {
                    choices.extend(group.iter().map(|o| (str_field(o, "value").unwrap_or_default(), str_field(o, "name").unwrap_or_default())));
                } else {
                    choices.push((str_field(item, "value").unwrap_or_default(), str_field(item, "name").unwrap_or_default()));
                }
            }
            *slot = Some(Selector {
                current: str_field(option, "currentValue").unwrap_or_default(),
                options: choices,
                config_id: Some(id),
            });
        }
    }

    pub fn request(&mut self, key: String, id: Value, seq: u64, msg: &Map<String, Value>) {
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        self.pending.push(Pending {
            key,
            id,
            seq,
            method: msg.get("method").and_then(Value::as_str).unwrap_or("").to_string(),
            session: str_field(&params, "sessionId"),
            options: params.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(|o| str_field(o, "optionId")).collect(),
        });
    }

    pub fn resolve(&mut self, key: &str) -> Option<Pending> {
        let at = self.pending.iter().position(|p| p.key == key)?;
        Some(self.pending.remove(at))
    }
}
