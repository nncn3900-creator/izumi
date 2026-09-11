// Enhancements and small behaviors for modern Reddit-like UI
console.log('assets/app.js loaded — UI enhancements active');

// Smooth scroll to comments when opening
const originalOpenComments = window.openComments || function(id){};
window.openComments = function(id){
    originalOpenComments(id);
    setTimeout(()=>{
        const modal = document.getElementById('modal-comments');
        if(modal) modal.querySelector('.modal').scrollIntoView({behavior:'smooth'});
    }, 120);
}

// Keyboard shortcut: 'n' to open new post modal
window.addEventListener('keydown', (e)=>{
    if(e.key === 'n' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA'){
        const modal = document.getElementById('modal-post');
        if(modal) modal.style.display = 'flex';
    }
});

// Tiny UX: close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(o=>{
    o.addEventListener('click', (ev)=>{
        if(ev.target === o) o.style.display='none';
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

function bindMediaInput(inputId, typeId, sourceId, previewId){
    const input = document.getElementById(inputId);
    if(!input) return;
    input.addEventListener('change', (event)=>{
        const file = event.target.files && event.target.files[0];
        if(!file) return;
        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');
        if(!isImage && !isVideo){
            input.value = '';
            alert('Yalnızca görsel veya video dosyası yükleyebilirsiniz.');
            return;
        }
        const maxSize = isVideo ? 12 * 1024 * 1024 : 5 * 1024 * 1024;
        if(file.size > maxSize){
            input.value = '';
            alert(isVideo ? 'Video boyutu en fazla 12 MB olabilir.' : 'Görsel boyutu en fazla 5 MB olabilir.');
            return;
        }
        fileToDataUrl(file, (error, data)=>{
            if(error){
                input.value = '';
                alert(error.message);
                return;
            }
            const type = isVideo ? file.type : 'image';
            const targetType = document.getElementById(typeId);
            const targetSource = document.getElementById(sourceId);
            if(targetType) targetType.value = type;
            if(targetSource) targetSource.value = data;
            const preview = document.getElementById(previewId);
            if(!preview) return;
            preview.innerHTML = '';
            const previewClass = previewId.includes('comment') ? 'comment-image' : 'post-image';
            if(type === 'image'){
                const image = document.createElement('img');
                image.src = data;
                image.className = previewClass;
                image.alt = 'Görsel önizleme';
                preview.appendChild(image);
            } else {
                const video = document.createElement('video');
                video.src = data;
                video.controls = true;
                video.className = previewClass;
                preview.appendChild(video);
            }
        });
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
    const maxSize = isVideo ? 12 * 1024 * 1024 : 5 * 1024 * 1024;
    if(file.size > maxSize){
        input.value = '';
        alert(isVideo ? 'Video boyutu en fazla 12 MB olabilir.' : 'Görsel boyutu en fazla 5 MB olabilir.');
        return;
    }
    fileToDataUrl(file, (error, data)=>{
        if(error){
            input.value = '';
            alert(error.message);
            return;
        }
        const targetType = document.getElementById(typeId);
        const targetSource = document.getElementById(sourceId);
        const preview = document.getElementById(previewId);
        if(targetType) targetType.value = isVideo ? file.type : 'image';
        if(targetSource) targetSource.value = data;
        if(!preview) return;
        preview.innerHTML = '';
        const previewClass = previewId.includes('comment') ? 'comment-image' : 'post-image';
        if(isImage){
            const image = document.createElement('img');
            image.src = data;
            image.className = previewClass;
            image.alt = 'Yorum görseli';
            preview.appendChild(image);
        } else {
            const video = document.createElement('video');
            video.src = data;
            video.controls = true;
            video.className = previewClass;
            preview.appendChild(video);
        }
    });
}

document.addEventListener('DOMContentLoaded', ()=>{
    bindMediaInput('post-file', 'post-media-type', 'post-media-src', 'post-media-preview');
    bindMediaInput('comment-file', 'comment-media-type', 'comment-media-src', 'comment-media-preview');
    bindMediaInput('prop-sub-avatar-file', 'prop-sub-avatar-type', 'prop-sub-avatar-src', 'prop-sub-avatar-upload-preview');

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
