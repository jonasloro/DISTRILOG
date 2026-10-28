/* Communication with Android. No demo card data and no direct cross-origin fetches. */
(function () {
  'use strict';
  var pending = Object.create(null);
  var next = 1;
  var TIMEOUT = 45000;
  function request(method, path, payload) {
    return new Promise(function (resolve, reject) {
      if (!window.DISTRILOG) {
        reject(new Error('Este aplicativo deve ser aberto pelo APK Android.'));
        return;
      }
      var id = next++;
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('O servidor demorou para responder. Confirme no DISTRILOG antes de repetir uma operação.'));
      }, TIMEOUT);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        DISTRILOG.request(id, method, path, payload ? JSON.stringify(payload) : '');
      } catch (error) {
        clearTimeout(timer); delete pending[id]; reject(error);
      }
    });
  }
  window.DM_NATIVE_RESULT = function (result) {
    var job = pending[result.id];
    if (!job) return;
    clearTimeout(job.timer);
    delete pending[result.id];
    if (result.ok) {
      job.resolve(result.data);
      return;
    }
    if (result.status === 401 && typeof window.DM_UNAUTHORIZED === 'function') {
      window.DM_UNAUTHORIZED();
    }
    job.reject(new Error(typeof result.error === 'string' ? result.error : 'Falha de comunicação com o sistema.'));
  };
  window.DM_API = {
    get: function (path) { return request('GET', path); },
    post: function (path, data) { return request('POST', path, data); },
    patch: function (path, data) { return request('PATCH', path, data); },
    endpoint: function () { return window.DISTRILOG ? DISTRILOG.endpoint() : ''; },
    configure: function (value) { return window.DISTRILOG && DISTRILOG.configure(value); },
    scan: function () { if (window.DISTRILOG) DISTRILOG.scan(); }
  };
})();
