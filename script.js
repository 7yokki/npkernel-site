// ==========================================================================
// NPKernel site — data loading and rendering
// ==========================================================================

(function () {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Static content data (from README)                                 */
  /* ---------------------------------------------------------------- */

  const STATUS_DATA = [
    { sub: 'Boot', state: 'ok', scope: 'Limine ile BIOS CD ve UEFI CD boot; higher-half ELF yükleme' },
    { sub: 'GOP/TTY', state: 'ok', scope: '1920×1080×32 hedefi, kalın 10×16 bitmap font, 2× hücre ölçeği, satır kaydırma; kontrollü framebuffer info/claim/map/release ABI\'si' },
    { sub: 'VGA ve log', state: 'ok', scope: 'VGA text fallback, GOP console, COM1 seri log, panic handler' },
    { sub: 'GDT/IDT/TSS', state: 'ok', scope: 'Ring 0/Ring 3 descriptor\'ları, TSS/RSP0, IST, 256 IDT gate\'i' },
    { sub: 'Kesme ve timer', state: 'ok', scope: 'PIC remap, IRQ1 keyboard, IRQ12 PS/2 mouse, IRQ0 PIT 100 Hz, tam GPR preemption frame\'i' },
    { sub: 'PMM/VMM', state: 'ok', scope: 'Refcount\'lu 4 KiB PMM, root-aware 4-level paging, user-range ve copyin/copyout' },
    { sub: 'Kernel heap', state: 'ok', scope: 'kmalloc, kcalloc, kfree; geçersiz ve double-free kontrolleri' },
    { sub: 'ELF64', state: 'ok', scope: 'ET_EXEC/ET_DYN, bounds/overlap doğrulama, W^X, NX, rollback; bounded PT_INTERP/PT_DYNAMIC interpreter handoff ve auxv' },
    { sub: 'Process/scheduler', state: 'ok', scope: 'PID/TID/TGID, kernel stack, gerçek context switch, timer tabanlı BSP preemption; bounded clone thread-group subset\'i ve exit_group' },
    { sub: 'VMA/mmap', state: 'ok', scope: 'Anonymous/file-backed mmap, immutable initramfs lazy faults, bounded shared-memory/device mapping, munmap, mprotect, brk, stack growth ve W^X' },
    { sub: 'Fork/COW', state: 'ok', scope: 'fork, low-half address-space clone, copy-on-write page resolution' },
    { sub: 'Exit/wait', state: 'ok', scope: 'Zombie süreç, parent wakeup, wait4/waitpid yolu, address-space/VMA/FD/stack cleanup' },
    { sub: 'VFS/initramfs', state: 'ok', scope: 'CPIO newc, bounded directory hierarchy ve canonical absolute paths, refcount\'lu open handles, paylaşımlı offset, pipe ring buffer, metadata/directory syscalls, bounded poll/ppoll/level-triggered epoll' },
    { sub: 'Persistent NPKFS', state: 'warn', scope: 'ATA PIO fixed-region /persist; create/read/write/truncate/append, close, fsync/fdatasync/sync ve readback metadata' },
    { sub: '/proc', state: 'base', scope: 'Process, thread ve memory bilgisi için pseudo-filesystem yolları' },
    { sub: 'ATA', state: 'base', scope: 'Primary ATA PIO probe/read/write yolu; Q35\'te cihaz yokluğu kontrollü ele alınır' },
    { sub: 'SMP', state: 'info', scope: 'Limine MP response, bounded CPU discovery ve QEMU -smp 2 AP online; AP scheduler migration\'ı henüz etkin değil' },
    { sub: 'Keyboard/input', state: 'ok', scope: 'PS/2 set-1 Türkçe Q text queue, structured key press/release events, IRQ12 PS/2 mouse REL/button events' },
    { sub: 'PCI', state: 'base', scope: 'PCI config mechanism #1 ile bounded bus/device/function enumeration; vendor/class/header/BAR metadata' },
    { sub: 'ACPI güç', state: 'ok', scope: 'RSDT/XSDT, FADT/DSDT _S5_, MADT/IOAPIC SCI, PM1 soft-off' },
    { sub: 'Linux ABI', state: 'info', scope: 'Desteklenmeyen syscall\'lar -ENOSYS; desteklenen yollar syscall tablosunda listelenir' },
  ];

  const STATE_LABEL = { ok: 'Çalışıyor', warn: 'Bounded', base: 'Temel', info: 'Bring-up' };

  const SYSCALL_FAMILIES = [
    { family: 'Dosya ve metadata', calls: ['read', 'write', 'open', 'close', 'fstat', 'stat', 'lseek', 'getdents64', 'getcwd', 'readlink'] },
    { family: 'Process/IPC', calls: ['getpid', 'gettid', 'fork', 'execve', 'exit', 'exit_group', 'set_tid_address', 'wait4', 'clone'] },
    { family: 'Bellek ve TLS', calls: ['mmap', 'munmap', 'mprotect', 'brk', 'arch_prctl'] },
    { family: 'Vectored/runtime I/O', calls: ['readv', 'writev', 'pipe', 'dup', 'dup2', 'fcntl', 'sched_yield', 'poll', 'ppoll', 'epoll', 'ioctl'] },
    { family: 'Sinyal ve fault yolu', calls: ['rt_sigaction', 'rt_sigprocmask', 'kill', 'tgkill', 'rt_sigqueueinfo', 'rt_tgsigqueueinfo', 'rt_sigreturn'] },
    { family: 'Zaman ve sistem', calls: ['clock_gettime', 'nanosleep', 'uname', 'futex', 'openat', 'fsync', 'fdatasync', 'sync'] },
  ];

  const DIR_TREE = [
    { t: 'npkernel/', c: 'dir' },
    { t: '├── Makefile', c: 'file' },
    { t: '├── README.md', c: 'file' },
    { t: '├── LICENSE', c: 'file' },
    { t: '├── TODO.md', c: 'file' },
    { t: '├── linker.ld', c: 'file' },
    { t: '├── limine.conf', c: 'file' },
    { t: '├── include/npk/       # Kernel public interfaces', c: 'dir' },
    { t: '├── boot/               # Limine request structures and boot handoff', c: 'dir' },
    { t: '├── arch/x86_64/        # Entry, GDT, IDT and interrupt assembly/C', c: 'dir' },
    { t: '├── src/', c: 'dir' },
    { t: '│   ├── arch/           # PIC, IDT, GDT, timer and ACPI paths', c: 'dir' },
    { t: '│   ├── drivers/        # TTY framebuffer, VGA, keyboard, PS/2 mouse, PCI and font', c: 'dir' },
    { t: '│   ├── exec/           # Secure ELF64 loader', c: 'dir' },
    { t: '│   ├── fs/             # CPIO-backed VFS and /proc', c: 'dir' },
    { t: '│   ├── memory/         # PMM, VMM, VMAs and COW', c: 'dir' },
    { t: '│   ├── proc/           # Process, thread and scheduler implementation', c: 'dir' },
    { t: '│   ├── syscall/        # Linux x86_64 syscall dispatcher', c: 'dir' },
    { t: '│   ├── console.c', c: 'file' },
    { t: '│   ├── log.c', c: 'file' },
    { t: '│   ├── panic.c', c: 'file' },
    { t: '│   └── kernel.c', c: 'file' },
    { t: '├── user/               # ELF64 smoke programs', c: 'dir' },
    { t: '├── tools/              # Initramfs and font build helpers', c: 'dir' },
    { t: '├── docs/               # Design and verification records', c: 'dir' },
    { t: '└── build/              # Generated ELF, ISO, symbols and test captures', c: 'dir' },
  ];

  const REQUIREMENTS = ['gcc', 'clang', 'lld', 'nasm', 'qemu-system-x86', 'xorriso', 'mtools', 'git', 'make', 'binutils'];

  const BUILD_COMMANDS = [
    { cmd: 'cd npkernel' },
    { cmd: 'make clean' },
    { cmd: 'make -j2 all disk' },
    { cmd: 'make check' },
    { cmd: 'make run', note: '# SeaBIOS / legacy-PC' },
    { cmd: 'make run-uefi', note: '# OVMF UEFI' },
    { cmd: 'make debug' },
  ];

  const BOOT_LINES = [
    { t: 'NPKernel v0.4 — No Problem Kernel', c: null },
    { t: '[Limine] BIOS CD boot ................ ', c: 'ok', suffix: 'OK' },
    { t: '[Limine] higher-half ELF yükleniyor ... ', c: 'ok', suffix: 'OK' },
    { t: '[GDT]  ring0/ring3 descriptor kurulumu  ', c: 'ok', suffix: 'OK' },
    { t: '[IDT]  256 gate kayıtlı ................ ', c: 'ok', suffix: 'OK' },
    { t: '[PIC]  remap + IRQ0 PIT 100 Hz ......... ', c: 'ok', suffix: 'OK' },
    { t: '[PMM]  refcount\'lu 4 KiB frame allocator ', c: 'ok', suffix: 'OK' },
    { t: '[VMM]  4-level paging, user-range aktif  ', c: 'ok', suffix: 'OK' },
    { t: '[VFS]  initramfs (cpio newc) bağlandı .. ', c: 'ok', suffix: 'OK' },
    { t: '[ACPI] RSDT/XSDT, PM1 soft-off ......... ', c: 'ok', suffix: 'OK' },
    { t: '[NPKFS] /persist fixed-region .......... ', c: 'warn', suffix: 'BOUNDED' },
    { t: '[SMP]  AP online (QEMU -smp 2) ......... ', c: 'info', suffix: 'BRING-UP' },
    { t: 'scheduler: BSP preemption başladı, PID 1 çalışıyor', c: null },
  ];

  /* ---------------------------------------------------------------- */
  /* Helpers                                                            */
  /* ---------------------------------------------------------------- */

  const $ = (id) => document.getElementById(id);

  async function loadJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('Failed to load ' + path);
    return res.json();
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(isoStr) {
    const d = new Date(isoStr + 'T00:00:00');
    if (isNaN(d)) return isoStr;
    const months = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  }

  /* ---------------------------------------------------------------- */
  /* Render: status table                                               */
  /* ---------------------------------------------------------------- */

  function renderStatusTable() {
    const tbody = $('status-tbody');
    tbody.innerHTML = STATUS_DATA.map((row) => `
      <tr>
        <td class="col-sub">
          ${escapeHTML(row.sub)}
          <span class="pill pill-${row.state}" style="display:none;">
            <span class="pill-dot"></span>${STATE_LABEL[row.state]}
          </span>
        </td>
        <td>
          <span class="pill pill-${row.state}">
            <span class="pill-dot"></span>${STATE_LABEL[row.state]}
          </span>
        </td>
        <td class="col-scope">${escapeHTML(row.scope)}</td>
      </tr>
    `).join('');
    // show inline pill on mobile row header, hide desktop-only duplicate via CSS handled by media query already;
    // simplify: remove the hidden duplicate, keep single pill column only.
    tbody.querySelectorAll('.col-sub .pill').forEach(el => el.remove());
  }

  /* ---------------------------------------------------------------- */
  /* Render: syscalls                                                   */
  /* ---------------------------------------------------------------- */

  function renderSyscalls() {
    const list = $('syscall-list');
    list.innerHTML = SYSCALL_FAMILIES.map((fam) => `
      <div class="syscall-row">
        <div class="syscall-family">${escapeHTML(fam.family)}</div>
        <div class="syscall-calls">
          ${fam.calls.map(c => `<span class="syscall-chip">${escapeHTML(c)}</span>`).join('')}
        </div>
      </div>
    `).join('');
  }

  /* ---------------------------------------------------------------- */
  /* Render: directory tree                                             */
  /* ---------------------------------------------------------------- */

  function renderTree() {
    const tree = $('dir-tree');
    tree.innerHTML = DIR_TREE.map((line) => {
      const parts = line.t.split('#');
      const main = parts[0];
      const comment = parts.length > 1 ? '#' + parts.slice(1).join('#') : '';
      const cls = line.c === 'dir' ? 't-dir' : 't-file';
      return `<div><span class="${cls}">${escapeHTML(main)}</span>${comment ? `<span class="t-comment">${escapeHTML(comment)}</span>` : ''}</div>`;
    }).join('');
  }

  /* ---------------------------------------------------------------- */
  /* Render: build requirements + commands                              */
  /* ---------------------------------------------------------------- */

  function renderBuild() {
    const reqList = $('req-list');
    reqList.innerHTML = REQUIREMENTS.map(r => `<li>${escapeHTML(r)}</li>`).join('');

    const pre = $('build-commands');
    pre.innerHTML = BUILD_COMMANDS.map(({ cmd, note }) =>
      `<span class="prompt">$</span> ${escapeHTML(cmd)}${note ? `  <span class="cmt">${escapeHTML(note)}</span>` : ''}`
    ).join('\n');
  }

  /* ---------------------------------------------------------------- */
  /* Render: boot console (typing animation)                            */
  /* ---------------------------------------------------------------- */

  function renderBootConsole() {
    const el = $('boot-console');
    el.innerHTML = '';
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion) {
      el.innerHTML = BOOT_LINES.map(lineHTML).join('');
      return;
    }

    let i = 0;
    function next() {
      if (i >= BOOT_LINES.length) {
        const cursor = document.createElement('div');
        cursor.className = 'console-line';
        cursor.innerHTML = '<span class="console-cursor"></span>';
        el.appendChild(cursor);
        return;
      }
      const div = document.createElement('div');
      div.className = 'console-line';
      div.innerHTML = lineHTML(BOOT_LINES[i]);
      el.appendChild(div);
      i++;
      setTimeout(next, i <= 1 ? 260 : 130);
    }
    next();
  }

  function lineHTML(line) {
    const tagClass = line.c ? `tag-${line.c}` : '';
    const suffix = line.suffix ? `<span class="${tagClass}">[${line.suffix}]</span>` : '';
    return `${escapeHTML(line.t)}${suffix}`;
  }

  /* ---------------------------------------------------------------- */
  /* Render: notifications from noti.json                               */
  /* ---------------------------------------------------------------- */

  function renderNotifications(items, localItems) {
    const list = $('noti-list');
    const count = $('noti-count');
    const local = localItems || [];

    if (!Array.isArray(items) || items.length === 0) {
      list.innerHTML = '<div class="noti-error">henüz güncelleme yok</div>';
      count.textContent = '';
      return;
    }

    const sorted = [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
    count.textContent = `${sorted.length} kayıt`;

    list.innerHTML = sorted.map((n) => {
      const isLocal = local.includes(n);
      return `
      <div class="noti-item${isLocal ? ' noti-item-local' : ''}">
        <div class="noti-date">${escapeHTML(formatDate(n.date))}</div>
        <div>
          <p class="noti-title">${escapeHTML(n.title)}</p>
          <p class="noti-desc">${escapeHTML(n.description)}</p>
          <span class="noti-author">${escapeHTML(n.author)}</span>
        </div>
      </div>
    `;
    }).join('');
  }

  /* ---------------------------------------------------------------- */
  /* Notification form — local additions                                */
  /* ---------------------------------------------------------------- */

  const LOCAL_NOTI_KEY = 'npkernel_local_notifications';

  function getLocalNotifications() {
    try {
      const raw = localStorage.getItem(LOCAL_NOTI_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocalNotifications(items) {
    try {
      localStorage.setItem(LOCAL_NOTI_KEY, JSON.stringify(items));
    } catch (e) {
      console.warn('Bildirim tarayıcıda saklanamadı:', e);
    }
  }

  function setupNotiForm(baseNotifications) {
    const toggle = $('noti-toggle');
    const form = $('noti-form');
    const cancel = $('noti-cancel');
    const exportBox = $('noti-export');
    const exportCode = $('noti-export-code');
    const copyBtn = $('noti-copy');
    if (!toggle || !form) return;

    let allItems = [...baseNotifications, ...getLocalNotifications()];

    function closeForm() {
      form.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', () => {
      const isOpen = !form.hidden;
      form.hidden = isOpen;
      toggle.setAttribute('aria-expanded', String(!isOpen));
      if (!isOpen) $('noti-input-date').focus();
    });

    cancel.addEventListener('click', () => {
      form.reset();
      closeForm();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();

      const entry = {
        date: $('noti-input-date').value,
        title: $('noti-input-title').value.trim(),
        description: $('noti-input-desc').value.trim(),
        author: $('noti-input-author').value.trim(),
      };
      if (!entry.date || !entry.title || !entry.description || !entry.author) return;

      const local = getLocalNotifications();
      local.push(entry);
      saveLocalNotifications(local);

      allItems = [...baseNotifications, ...local];
      renderNotifications(allItems, local);

      exportCode.textContent = JSON.stringify(entry, null, 2) + ',';
      exportBox.hidden = false;

      form.reset();
      closeForm();
      exportBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(exportCode.textContent);
          copyBtn.textContent = 'Kopyalandı';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Kopyala';
            copyBtn.classList.remove('copied');
          }, 1600);
        } catch (e) {
          console.warn('Panoya kopyalanamadı:', e);
        }
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render: links from urls.json                                       */
  /* ---------------------------------------------------------------- */

  const LINK_LABELS = {
    repo: 'Repository',
    issues: 'Issues',
    pulls: 'Pull Requests',
    actions: 'Actions',
    commits: 'Commits',
    license: 'License (MIT)',
    readme: 'README.md',
    todo: 'TODO.md',
    verification_doc: 'docs/verification.md',
    limine_findings_doc: 'docs_limine_findings.md',
    makefile: 'Makefile',
    src_dir: 'src/',
    arch_dir: 'arch/x86_64/',
    boot_dir: 'boot/',
    include_dir: 'include/',
    initramfs_dir: 'initramfs/',
    tests_dir: 'tests/',
    tools_dir: 'tools/',
    user_dir: 'user/',
    docs_dir: 'docs/',
    author_profile: '7yokki (yazar)',
  };

  const LINK_ORDER = ['repo', 'readme', 'issues', 'pulls', 'commits', 'actions', 'src_dir', 'docs_dir', 'verification_doc', 'todo', 'license', 'author_profile'];

  function applyUrls(urls) {
    // Wire up specific named links in the page
    const setHref = (id, url) => { const el = $(id); if (el && url) el.href = url; };

    setHref('hero-repo-btn', urls.repo);
    setHref('repo-star-link', urls.repo);
    setHref('hero-license-btn', urls.license);
    setHref('license-strip-link', urls.license);
    setHref('footer-issues-link', urls.issues);
    setHref('footer-pulls-link', urls.pulls);
    setHref('footer-commits-link', urls.commits);
    setHref('footer-author-link', urls.author_profile);

    // Nav links (data-href style not used; wire the static anchors already correct)

    // Resource grid
    const grid = $('link-grid');
    if (grid) {
      grid.innerHTML = LINK_ORDER
        .filter((key) => urls[key])
        .map((key) => {
          const url = urls[key];
          const label = LINK_LABELS[key] || key;
          let displayPath;
          try {
            const u = new URL(url);
            displayPath = u.hostname + u.pathname;
          } catch (e) {
            displayPath = url;
          }
          return `
            <a class="link-card" href="${url}" target="_blank" rel="noopener">
              <span class="lc-name">${escapeHTML(label)} <span class="lc-arrow" aria-hidden="true">↗</span></span>
              <span class="lc-path">${escapeHTML(displayPath)}</span>
            </a>
          `;
        }).join('');
    }

    // Favicon override if provided and different from default (best-effort, ignore if not reachable)
  }

  /* ---------------------------------------------------------------- */
  /* Init                                                               */
  /* ---------------------------------------------------------------- */

  async function init() {
    renderStatusTable();
    renderSyscalls();
    renderTree();
    renderBuild();
    renderBootConsole();

    try {
      const urls = await loadJSON('urls.json');
      applyUrls(urls);
    } catch (e) {
      console.warn('urls.json yüklenemedi:', e);
    }

    let baseNoti = [];
    try {
      baseNoti = await loadJSON('noti.json');
    } catch (e) {
      console.warn('noti.json yüklenemedi:', e);
    }

    const local = getLocalNotifications();
    if (baseNoti.length || local.length) {
      renderNotifications([...baseNoti, ...local], local);
    } else {
      $('noti-list').innerHTML = '<div class="noti-error">güncellemeler yüklenemedi</div>';
    }
    setupNotiForm(baseNoti);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
