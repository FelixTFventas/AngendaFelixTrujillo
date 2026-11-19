(function (root) {
  class SimiPropertyPicker {
    constructor({ client, form, getContext }) {
      this.client = client;
      this.form = form;
      this.getContext = getContext;
      this.container = document.querySelector('#simiPropertyPicker');
      this.query = document.querySelector('#simiPropertyQuery');
      this.results = document.querySelector('#simiPropertyResults');
      this.status = document.querySelector('#simiPropertyStatus');
      this.syncButton = document.querySelector('#simiSyncButton');
      this.probeButton = document.querySelector('#simiProbeButton');
      this.pauseButton = document.querySelector('#simiPauseButton');
      this.restartButton = document.querySelector('#simiRestartButton');
      this.batchProgress = null;
      this.pauseRequested = false;
      this.input = form.elements.property;
      this.sequence = 0;
      this.syncing = false;
      this.selected = null;
      this.selectedText = '';
      this.candidates = new Map();
      this.query.addEventListener('input', () => {
        this.cancelSearch();
        this.results.replaceChildren();
        this.candidates.clear();
        if (!this.enabled()) return;
        if (this.query.value.trim().length < 2) {
          this.results.replaceChildren();
          this.status.textContent = 'Escribe al menos 2 caracteres. También puedes escribir la dirección manualmente.';
          return;
        }
        this.timer = setTimeout(() => this.search(), 350);
      });
      this.query.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); this.search(); }
      });
      document.querySelector('#simiSearchButton').addEventListener('click', () => this.search());
      document.querySelector('#simiManualButton').addEventListener('click', () => {
        this.cancelSearch();
        this.selected = null;
        this.query.value = '';
        this.results.replaceChildren();
        this.renderSelection();
        this.status.textContent = 'Puedes escribir o ajustar la dirección en el campo de abajo.';
        this.input.focus();
      });
      this.input.addEventListener('input', () => {
        if (this.selected && this.input.value !== this.selectedText) {
          this.selected = null;
          this.renderSelection();
        }
      });
      this.results.addEventListener('click', event => {
        const button = event.target.closest('[data-simi-code]');
        if (button) this.select(button.dataset.simiCode);
      });
      this.syncButton.addEventListener('click', () => this.sync());
      this.probeButton.addEventListener('click', () => this.probe());
      this.pauseButton.addEventListener('click', () => {
        this.pauseRequested = true;
        this.pauseButton.disabled = true;
        this.status.textContent = 'Pausando al terminar el lote en curso. Las páginas confirmadas quedarán guardadas.';
      });
      this.restartButton.addEventListener('click', () => {
        if (!this.enabled() || this.getContext().profile?.role !== 'admin' || this.syncing
          || this.batchProgress?.status !== 'failed') return;
        if (root.confirm('¿Reiniciar solo la descarga parcial? El catálogo publicado y las citas no se modificarán.')) {
          this.runAction('restart');
        }
      });
      form.closest('dialog').addEventListener('close', () => this.cancelSearch());
    }

    static safeURL(value) {
      return /^https:\/\/felixtrujillofalla\.com\/inmuebles\/(arriendo|venta)\/detalle\/[0-9]+-[0-9]+\/?$/.test(String(value || ''))
        ? value : '';
    }

    enabled() {
      const { subject, profile } = this.getContext();
      return subject === 'Visita comercial' && profile?.active === true && profile.must_change_password === false;
    }

    cancelSearch() {
      clearTimeout(this.timer);
      this.sequence += 1;
      this.results.setAttribute('aria-busy', 'false');
    }

    reset() {
      this.cancelSearch();
      this.selected = null;
      this.selectedText = '';
      this.candidates.clear();
      this.query.value = '';
      this.results.replaceChildren();
      this.status.textContent = '';
      this.batchProgress = null;
      this.container.hidden = true;
      this.renderSelection();
      this.renderBatchProgress();
    }

    open(appointment) {
      this.reset();
      if (appointment?.simiPropertyCode && SimiPropertyPicker.safeURL(appointment.simiPropertyURL)) {
        this.selected = { code: appointment.simiPropertyCode, url: appointment.simiPropertyURL };
        this.selectedText = this.input.value;
      }
      this.updateContext();
    }

    updateContext() {
      this.cancelSearch();
      const enabled = this.enabled();
      this.container.hidden = !enabled;
      this.syncButton.hidden = !enabled || this.getContext().profile?.role !== 'admin';
      this.probeButton.hidden = this.syncButton.hidden;
      this.syncButton.disabled = this.syncing;
      this.probeButton.disabled = this.syncing;
      this.results.replaceChildren();
      this.candidates.clear();
      this.status.textContent = 'Busca por código, barrio o conjunto. Se consulta el catálogo guardado, no SIMI en cada búsqueda.';
      this.renderSelection();
      this.renderBatchProgress();
    }

    renderSelection() {
      const selection = document.querySelector('#simiPropertySelection');
      const link = document.querySelector('#simiPropertyLink');
      selection.hidden = !this.selected || !this.enabled();
      link.removeAttribute('href');
      if (this.selected) {
        document.querySelector('#simiSelectedCode').textContent = `Inmueble ${this.selected.code}`;
        const url = SimiPropertyPicker.safeURL(this.selected.url);
        if (url) link.href = url;
      }
    }

    snapshot() {
      if (!this.enabled() || !this.selected || this.input.value !== this.selectedText) return null;
      return { code: this.selected.code, url: this.selected.url };
    }

    async search() {
      this.cancelSearch();
      if (!this.enabled()) return;
      const query = this.query.value.trim();
      this.results.replaceChildren();
      this.candidates.clear();
      if (query.length < 2 || query.length > 120) {
        this.status.textContent = 'Escribe entre 2 y 120 caracteres para buscar, o utiliza la dirección manual.';
        return;
      }
      const sequence = this.sequence;
      this.status.textContent = 'Buscando en el catálogo…';
      this.results.setAttribute('aria-busy', 'true');
      try {
        const { data, error } = await this.client.rpc('search_simi_properties', {
          query_text: query, target_team: this.getContext().team || 'all', appointment_subject: 'Visita comercial',
        });
        if (sequence !== this.sequence || !this.enabled()) return;
        if (error) throw error;
        const properties = Array.isArray(data?.properties) ? data.properties : [];
        for (const property of properties) {
          if (!/^\d+-\d+$/.test(property.code) || !SimiPropertyPicker.safeURL(property.url)) continue;
          this.candidates.set(property.code, property);
          const item = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.simiCode = property.code;
          const title = document.createElement('strong');
          title.textContent = `${property.code} · ${property.title}`;
          const description = document.createElement('span');
          description.textContent = [property.rental ? 'Arriendo' : '', property.sales ? 'Venta' : '', property.address].filter(Boolean).join(' · ');
          button.append(title, description);
          item.append(button);
          this.results.append(item);
        }
        const updated = data?.last_synced_at ? new Date(data.last_synced_at) : null;
        const label = updated && !Number.isNaN(updated.getTime())
          ? ` Última actualización: ${new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short' }).format(updated)}.` : '';
        this.status.textContent = !data?.last_synced_at
          ? 'El catálogo aún no se ha sincronizado. El administrador puede actualizarlo; mientras tanto utiliza la dirección manual.'
          : this.candidates.size ? `Selecciona un inmueble de la lista.${label}`
            : `No hay coincidencias para este equipo. Puedes escribir la dirección manualmente.${label}`;
      } catch (error) {
        if (sequence !== this.sequence || !this.enabled()) return;
        this.status.textContent = ['PGRST202', '42883'].includes(error?.code)
          ? 'Falta activar el catálogo en Supabase. Puedes continuar con la dirección manual.'
          : 'No fue posible consultar el catálogo. Puedes continuar con la dirección manual.';
      } finally {
        if (sequence === this.sequence) this.results.setAttribute('aria-busy', 'false');
      }
    }

    select(code) {
      if (!this.enabled()) return;
      const property = this.candidates.get(code);
      if (!property) return;
      this.selected = property;
      this.selectedText = [property.code, property.title, property.address].filter(Boolean).join(' · ');
      this.input.value = this.selectedText;
      this.cancelSearch();
      this.results.replaceChildren();
      this.query.value = '';
      this.renderSelection();
      this.status.textContent = 'Inmueble seleccionado. Su descripción se conservará en esta cita.';
    }

    sync() { return this.runAction('sync'); }

    probe() { return this.runAction('probe'); }

    setBatchProgress(value) {
      if (!value || !['idle', 'pending', 'complete', 'failed', 'busy', 'waiting'].includes(value.status)
        || !Number.isInteger(value.next_page) || value.next_page < 1 || value.next_page > 201
        || !Number.isInteger(value.received) || value.received < 0 || value.received > 10000) return false;
      this.batchProgress = {
        status: value.restart_required ? 'failed' : value.status, next_page: value.next_page, received: value.received,
        total: Number.isInteger(value.total) && value.total > 0 ? value.total : null,
        total_pages: Number.isInteger(value.total_pages) && value.total_pages > 0 ? value.total_pages : null,
      };
      this.renderBatchProgress();
      return true;
    }

    progressLabel() {
      if (!this.batchProgress) return 'Preparando carga por lotes…';
      const { received, next_page, total, total_pages } = this.batchProgress;
      const count = new Intl.NumberFormat('es-CO').format(received);
      return `${count}${total ? ` de ${new Intl.NumberFormat('es-CO').format(total)}` : ''} inmuebles guardados · ${next_page - 1}${total_pages ? ` de ${total_pages}` : ''} páginas`;
    }

    renderBatchProgress() {
      const working = this.syncing && this.activeAction !== 'probe';
      const allowed = this.enabled() && this.getContext().profile?.role === 'admin';
      document.querySelector('#simiBatchProgress').hidden = !allowed || (!this.batchProgress && !working);
      document.querySelector('#simiBatchLabel').textContent = this.progressLabel();
      const bar = document.querySelector('#simiBatchBar');
      const { received = 0, next_page = 1, total, total_pages } = this.batchProgress || {};
      if (this.batchProgress?.status === 'complete') {
        bar.max = 1;
        bar.value = 1;
      } else if (total || total_pages) {
        bar.max = total || total_pages;
        bar.value = total ? received : next_page - 1;
      } else bar.removeAttribute('value');
      this.pauseButton.hidden = !allowed || !working;
      this.pauseButton.disabled = this.pauseRequested;
      this.restartButton.hidden = !allowed || this.batchProgress?.status !== 'failed';
      this.restartButton.disabled = this.syncing;
      this.syncButton.textContent = ['pending', 'busy', 'waiting'].includes(this.batchProgress?.status)
        ? 'Continuar carga' : 'Actualizar catálogo';
    }

    async runAction(action) {
      if (!this.enabled() || this.getContext().profile?.role !== 'admin' || this.syncing) return;
      this.cancelSearch();
      const sequence = this.sequence;
      this.syncing = true;
      this.activeAction = action;
      this.pauseRequested = false;
      this.syncButton.disabled = true;
      this.probeButton.disabled = true;
      this.renderBatchProgress();
      this.status.textContent = action === 'probe'
        ? 'Probando una consulta pequeña de lectura a SIMI, sin actualizar el catálogo…'
        : 'Cargando un lote de SIMI. El avance se guardará página por página…';
      try {
        let previousPage = action !== 'restart' && ['pending', 'busy', 'waiting'].includes(this.batchProgress?.status)
          ? this.batchProgress.next_page : 1;
        for (let batch = 0; batch < 20; batch += 1) {
          if (sequence !== this.sequence || !this.enabled()) return;
          const options = action === 'probe'
            ? { method: 'GET', headers: { 'x-simi-appointment-subject': 'Visita comercial' } }
            : { body: { appointment_subject: 'Visita comercial', sync_protocol: 'batch-v1', ...(action === 'restart' ? { action } : {}) } };
          const { data, error } = await this.client.functions.invoke('simi-catalog-sync', options);
          if (sequence !== this.sequence || !this.enabled()) return;
          if (error) {
            let message = 'No fue posible actualizar el catálogo. Revisa la función y los secretos en Supabase.';
            try {
              const payload = await error.context.json();
              this.setBatchProgress(payload.progress);
              message = typeof payload.error === 'string' ? payload.error : message;
              if (/^SIMI_[A-Z_]+$/.test(payload.code || '')) {
                const page = Number.isInteger(payload.diagnostic?.page) ? `, página ${payload.diagnostic.page}` : '';
                message = `${payload.code}${page}: ${message}`;
              }
            } catch {}
            throw new Error(message);
          }
          if (action === 'probe') {
            this.status.textContent = data?.code === 'SIMI_OK'
              ? 'Conexión con SIMI comprobada. Ahora puedes pulsar Actualizar catálogo. La prueba no cambió ningún inmueble.'
              : 'La función necesita actualizarse para admitir esta prueba. El catálogo no se ha modificado.';
            return;
          }
          const hasProgress = this.setBatchProgress(data);
          if (data?.status === 'complete' || (!data?.status && Number.isInteger(data?.count))) {
            this.status.textContent = `Catálogo completo publicado: ${Number(data.count ?? data.received) || 0} inmuebles. SIMI no ha sido modificado.`;
            if (this.query.value.trim().length >= 2) await this.search();
            return;
          }
          if (!hasProgress || data.status !== 'pending' || data.next_page <= previousPage) {
            throw new Error('La función no confirmó un avance nuevo. La carga se detuvo para evitar repetir consultas.');
          }
          previousPage = data.next_page;
          this.status.textContent = `${this.progressLabel()}. Continuando desde la página ${data.next_page}…`;
          if (this.pauseRequested || batch === 19) {
            this.status.textContent = `${this.progressLabel()}. Carga pausada; pulsa Continuar carga para reanudar.`;
            return;
          }
          action = 'sync';
        }
      } catch (error) {
        if (sequence === this.sequence && this.enabled()) {
          this.status.textContent = `${error.message || 'No fue posible actualizar el catálogo.'} Puedes utilizar la dirección manual.`;
          if (this.batchProgress?.status === 'pending') this.status.textContent += ` El avance se conserva desde la página ${this.batchProgress.next_page}.`;
        }
      } finally {
        this.syncing = false;
        this.activeAction = null;
        this.syncButton.disabled = false;
        this.probeButton.disabled = false;
        this.renderBatchProgress();
      }
    }
  }
  root.SimiPropertyPicker = SimiPropertyPicker;
})(globalThis);
