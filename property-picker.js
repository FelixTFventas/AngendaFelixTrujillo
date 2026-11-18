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
      this.container.hidden = true;
      this.renderSelection();
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
      this.syncButton.disabled = this.syncing;
      this.results.replaceChildren();
      this.candidates.clear();
      this.status.textContent = 'Busca por código, barrio o conjunto. Se consulta el catálogo guardado, no SIMI en cada búsqueda.';
      this.renderSelection();
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

    async sync() {
      if (!this.enabled() || this.getContext().profile?.role !== 'admin' || this.syncing) return;
      this.cancelSearch();
      const sequence = this.sequence;
      this.syncing = true;
      this.syncButton.disabled = true;
      this.status.textContent = 'Actualizando el catálogo mediante consultas de lectura a SIMI…';
      try {
        const { data, error } = await this.client.functions.invoke('simi-catalog-sync', {
          body: { appointment_subject: 'Visita comercial' },
        });
        if (error) {
          let message = 'No fue posible actualizar el catálogo. Revisa la función y los secretos en Supabase.';
          try { message = (await error.context.json()).error || message; } catch {}
          throw new Error(message);
        }
        if (sequence !== this.sequence || !this.enabled()) return;
        this.status.textContent = `Catálogo actualizado: ${Number(data?.count) || 0} inmuebles. SIMI no ha sido modificado.`;
        if (this.query.value.trim().length >= 2) await this.search();
      } catch (error) {
        if (sequence === this.sequence && this.enabled()) {
          this.status.textContent = `${error.message || 'No fue posible actualizar el catálogo.'} Puedes utilizar la dirección manual.`;
        }
      } finally {
        this.syncing = false;
        this.syncButton.disabled = false;
      }
    }
  }
  root.SimiPropertyPicker = SimiPropertyPicker;
})(globalThis);
