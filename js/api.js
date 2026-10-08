// EcoScrap AI Backend API Client — thin fetch wrapper over the real Express + SQLite backend
const API = {
  async _send(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  bootstrap() { return this._send('GET', '/api/bootstrap'); },

  kabadiwalaLogin(phone, pin) { return this._send('POST', '/api/auth/kabadiwala-login', { phone, pin }); },
  kabadiwalaRegister(payload) { return this._send('POST', '/api/auth/kabadiwala-register', payload); },
  recyclerLogin(payload) { return this._send('POST', '/api/auth/recycler-login', payload); },

  listLots(params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this._send('GET', `/api/lots${qs}`);
  },
  createLot(payload) { return this._send('POST', '/api/lots', payload); },
  poolBookingsIntoLot(payload) { return this._send('POST', '/api/lots/pool', payload); },
  confirmLotPayment(lotId) { return this._send('PATCH', `/api/lots/${encodeURIComponent(lotId)}/confirm-payment`); },

  updateMaterialRate(materialId, payload) { return this._send('PATCH', `/api/materials/${encodeURIComponent(materialId)}/rate`, payload); },
  updateRecyclerOwnRate(recyclerId, materialId, rate) { return this._send('PATCH', `/api/recyclers/${encodeURIComponent(recyclerId)}/materials/${encodeURIComponent(materialId)}/rate`, { rate }); },
  getMaterialHistory(materialId, days) {
    const qs = days ? `?days=${encodeURIComponent(days)}` : '';
    return this._send('GET', `/api/materials/${encodeURIComponent(materialId)}/history${qs}`);
  },

  scanScrapPhoto(imageDataUrl) { return this._send('POST', '/api/scan', { imageDataUrl }); },

  createBooking(payload) { return this._send('POST', '/api/bookings', payload); },
  // body: { confirmedBy: 'customer' | 'dealer', otp, weighedKg, amountPaid, acceptShortfall, dispute }
  completeBooking(bookingId, body) { return this._send('PATCH', `/api/bookings/${encodeURIComponent(bookingId)}/complete`, body || {}); },
  listBookings(params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this._send('GET', `/api/bookings${qs}`);
  },
  getCustomerSummary(phone) { return this._send('GET', `/api/customers/${encodeURIComponent(phone)}/summary`); },

  createCollectionSchedule(payload) { return this._send('POST', '/api/collection-schedules', payload); },
  listCollectionSchedules(params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this._send('GET', `/api/collection-schedules${qs}`);
  },

  listInstitutions() { return this._send('GET', '/api/institutions'); },
  createInstitution(payload) { return this._send('POST', '/api/institutions', payload); },
  linkInstitutionDealer(id, payload) { return this._send('PATCH', `/api/institutions/${encodeURIComponent(id)}/link-dealer`, payload); },

  listContracts(customerId) { return this._send('GET', `/api/contracts?${new URLSearchParams({ customerId }).toString()}`); },
  createContract(payload) { return this._send('POST', '/api/contracts', payload); },
  renewContract(id) { return this._send('PATCH', `/api/contracts/${encodeURIComponent(id)}/renew`); },
  switchContract(id, payload) { return this._send('PATCH', `/api/contracts/${encodeURIComponent(id)}/switch`, payload); },

  sendPriceListSms(kabadiId) { return this._send('POST', `/api/kabadiwalas/${encodeURIComponent(kabadiId)}/send-price-sms`); },
  triggerDailyPriceListBroadcast() { return this._send('POST', '/api/notifications/send-daily-price-list'); },

  listMessages(kabadiwalaId, recyclerId) {
    const qs = new URLSearchParams({ kabadiwalaId, recyclerId }).toString();
    return this._send('GET', `/api/messages?${qs}`);
  },
  sendMessage(payload) { return this._send('POST', '/api/messages', payload); }
};

window.API = API;
