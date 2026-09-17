// Enhancements and small behaviors for modern Reddit-like UI
console.log('assets/app.js loaded — UI enhancements active');

// Keyboard shortcut: 'n' to open new post modal
window.addEventListener('keydown', (e)=>{
    if(e.key === 'n' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'SELECT'){
        if(typeof openPostComposer === 'function') openPostComposer();
    }
});

// Tiny UX: close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(o=>{
    o.addEventListener('click', (ev)=>{
        if(ev.target === o && typeof closeModal === 'function') closeModal(o.id);
    });
});

// Improve initial rendering: add subtle animation
setTimeout(()=>{
    document.querySelectorAll('.post-card').forEach((c,i)=>{
        c.style.opacity = 0; c.style.transform = 'translateY(6px)';
        setTimeout(()=>{ c.style.transition='all .28s cubic-bezier(.2,.9,.2,1)'; c.style.opacity=1; c.style.transform='none'; }, i*60);
    });
}, 120);

// --- File uploads (post media and profile avatar) ---
function fileToDataUrl(file, cb){
    const reader = new FileReader();
    reader.onload = () => cb(null, reader.result);
    reader.onerror = () => cb(new Error('Dosya okunamadı.'));
    reader.readAsDataURL(file);
}

async function uploadMediaFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('/api/upload-media', {
        method: 'POST',
        body: formData
    });

    const payload = await response.json().catch(() => ({}));
    if(!response.ok || !payload.ok || !payload.url) {
        throw new Error(payload.message || payload.error || 'Dosya yüklenemedi.');
    }

    return payload;
}

function bindMediaInput(inputId, typeId, sourceId, previewId){
    const input = document.getElementById(inputId);
    if(!input) return;
    input.addEventListener('change', async (event)=>{
        const file = event.target.files && event.target.files[0];
        if(!file) return;
        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');
        if(!isImage && !isVideo){
            input.value = '';
            alert('Yalnızca görsel veya video dosyası yükleyebilirsiniz.');
            return;
        }
        const maxSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
        if(file.size > maxSize){
            input.value = '';
            alert(isVideo ? 'Video boyutu en fazla 50 MB olabilir.' : 'Görsel boyutu en fazla 10 MB olabilir.');
            return;
        }

        try {
            const result = await uploadMediaFile(file);
            const type = isVideo ? file.type : 'image';
            const targetType = document.getElementById(typeId);
            const targetSource = document.getElementById(sourceId);
            if(targetType) targetType.value = type;
            if(targetSource) targetSource.value = result.url;
            const preview = document.getElementById(previewId);
            if(!preview) return;
            preview.innerHTML = '';
            const previewClass = previewId.includes('comment') ? 'comment-image' : 'post-image';
            if(type === 'image'){
                const image = document.createElement('img');
                image.src = result.url;
                image.className = previewClass;
                image.alt = 'Görsel önizleme';
                preview.appendChild(image);
            } else {
                const video = document.createElement('video');
                video.src = result.url;
                video.controls = true;
                video.className = previewClass;
                preview.appendChild(video);
            }
        } catch (error) {
            input.value = '';
            alert(error.message || 'Dosya yüklenemedi.');
        }
    });
}

function handleCommentMediaInput(input, typeId, sourceId, previewId){
    const file = input.files && input.files[0];
    if(!file) return;
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if(!isImage && !isVideo){
        input.value = '';
        alert('Yalnızca görsel veya video dosyası yükleyebilirsiniz.');
        return;
    }
    const maxSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
    if(file.size > maxSize){
        input.value = '';
        alert(isVideo ? 'Video boyutu en fazla 50 MB olabilir.' : 'Görsel boyutu en fazla 10 MB olabilir.');
        return;
    }

    uploadMediaFile(file)
        .then((result) => {
            const targetType = document.getElementById(typeId);
            const targetSource = document.getElementById(sourceId);
            const preview = document.getElementById(previewId);
            if(targetType) targetType.value = isVideo ? file.type : 'image';
            if(targetSource) targetSource.value = result.url;
            if(!preview) return;
            preview.innerHTML = '';
            const previewClass = previewId.includes('comment') ? 'comment-image' : 'post-image';
            if(isImage){
                const image = document.createElement('img');
                image.src = result.url;
                image.className = previewClass;
                image.alt = 'Yorum görseli';
                preview.appendChild(image);
            } else {
                const video = document.createElement('video');
                video.src = result.url;
                video.controls = true;
                video.className = previewClass;
                preview.appendChild(video);
            }
        })
        .catch((error) => {
            input.value = '';
            alert(error.message || 'Dosya yüklenemedi.');
        });
}

document.addEventListener('DOMContentLoaded', ()=>{
    bindMediaInput('post-file', 'post-media-type', 'post-media-src', 'post-media-preview');
    bindMediaInput('comment-file', 'comment-media-type', 'comment-media-src', 'comment-media-preview');
    bindMediaInput('prop-sub-avatar-file', 'prop-sub-avatar-type', 'prop-sub-avatar-src', 'prop-sub-avatar-upload-preview');
    bindMediaInput('sub-avatar-file', 'sub-avatar-type', 'sub-avatar-src', 'sub-avatar-upload-preview');

    const galleryInput = document.getElementById('post-gallery');
    if(galleryInput){
        galleryInput.addEventListener('change', async event => {
            const files = Array.from(event.target.files || []).slice(0, 8);
            const validFiles = files.filter(file => file.type.startsWith('image/') && file.size <= 5 * 1024 * 1024);
            if(validFiles.length !== files.length) alert('Gallery images must be images up to 5 MB each.');
            window.izumiGalleryData = await Promise.all(validFiles.map(file => new Promise(resolve => {
                fileToDataUrl(file, (error, data) => resolve(error ? null : { type: file.type, src: data }));
            })));
            window.izumiGalleryData = window.izumiGalleryData.filter(Boolean);
            const preview = document.getElementById('gallery-preview');
            if(preview) preview.innerHTML = window.izumiGalleryData.map(item => `<img src="${item.src}" alt="Gallery preview">`).join('');
        });
    }

    const avatarInput = document.getElementById('profile-avatar-input');
    if(avatarInput){
        avatarInput.addEventListener('change', (ev)=>{
            const f = ev.target.files && ev.target.files[0];
            if(!f) return;
            fileToDataUrl(f, (error, data)=>{
                if(error){
                    alert(error.message);
                    return;
                }
                // save to state global
                if(window.state && window.state.user){
                    window.state.user.avatar = data;
                    window.saveState && window.saveState();
                    window.renderProfile && window.renderProfile();
                    const imgEl = document.getElementById('profile-avatar-img');
                    imgEl.src = data; imgEl.style.display = 'block';
                }
            });
        });
    }
});

function renderMarkdown(value = ''){
    const source = String(value || '');
    if(!window.marked) return escapeMarkup(source);
    const html = window.marked.parse(source, { breaks: true, gfm: true });
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script, iframe, object, embed, style').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
        Array.from(node.attributes).forEach(attribute => {
            if(attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase() === 'style') node.removeAttribute(attribute.name);
        });
    });
    return template.innerHTML;
}

function escapeMarkup(value){
    return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function applyIzumiTheme(theme){
    const selected = ['dark', 'oled', 'gray', 'light'].includes(theme) ? theme : 'dark';
    document.documentElement.dataset.theme = selected;
    localStorage.setItem('izumi_theme', selected);
    const select = document.getElementById('theme-select');
    if(select) select.value = selected;
}

document.addEventListener('DOMContentLoaded', () => {
    applyIzumiTheme(localStorage.getItem('izumi_theme') || 'dark');
    const updateThemeLabel = () => {
        const label = document.getElementById('theme-label');
        if(label) label.textContent = (localStorage.getItem('iz_language') || 'tr') === 'en' ? 'Theme' : 'Tema';
    };
    updateThemeLabel();
    document.getElementById('language-select')?.addEventListener('change', updateThemeLabel);
    document.getElementById('theme-select')?.addEventListener('change', event => applyIzumiTheme(event.target.value));

    if(window.io){
        const socket = window.io();
        window.izumiSocket = socket;
        socket.emit('join-feed');
        socket.on('state-updated', async () => {
            if(typeof window.loadStateFromServer === 'function') await window.loadStateFromServer();
        });
    }
});
