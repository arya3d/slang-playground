'use strict';

var compiler = null;
var slangd = null;
var device;
var context;
var computePipeline;
var extraComputePipelines = [];
var passThroughPipeline;

var monacoEditor;
var diagnosticsArea;
var codeGenArea;

var resourceBindings;
var resourceCommands;
var callCommands;
var allocatedResources;
var hashedStrings;

var renderThread = null;
var releaseRenderLock = null;
var abortRender = false;
var onRenderAborted = null;

var printfBufferElementSize = 12;
var printfBufferSize = this.printfBufferElementSize * 2048; // 12 bytes per printf struct

var sourceCodeChange = true;

var currentWindowSize = [300, 150];

const RENDER_MODE = SlangCompiler.RENDER_SHADER;
const PRINT_MODE = SlangCompiler.PRINT_SHADER;
const HIDDEN_MODE = SlangCompiler.NON_RUNNABLE_SHADER;
const defaultShaderURL = "circle.slang";

var currentMode = RENDER_MODE;

var randFloatPipeline;
var randFloatResources;

async function webgpuInit() {
    try {
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter) {
            console.log('need a browser that supports WebGPU');
            return;
        }
        const requiredFeatures = [];

        device = await adapter?.requestDevice({ requiredFeatures });
        if (!device) {
            console.log('need a browser that supports WebGPU');
            return;
        }
        context = configContext(device, canvas);
    }
    catch {
    }
    // The default resolution of a canvas element is 300x150, which is too small compared to the container size of the canvas,
    // therefore, we have to set the resolution same as the container size.

    const observer = new ResizeObserver((entries) => { resizeCanvasHandler(entries); });
    observer.observe(canvas);
}

function resizeCanvas(entries) {
    if (device == null)
        return;

    const canvas = entries[0].target;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.style.display == "none") {
        var parentDiv = document.getElementById("output");
        width = parentDiv.clientWidth;
        height = parentDiv.clientHeight;
    }

    if (width != currentWindowSize[0] || height != currentWindowSize[1]) {
        // ensure the size won't be 0 nor exceed the limit, otherwise WebGPU will throw an errors
        canvas.width = Math.max(2, Math.min(width, device.limits.maxTextureDimension2D));
        canvas.height = Math.max(2, Math.min(height, device.limits.maxTextureDimension2D));

        currentWindowSize = [canvas.width, canvas.height];
        return true;
    }

    return false;
}

function abortRendererIfActive()
{
    return new Promise((resolve) => {
        if (renderThread)
        {
            abortRender = true;
            onRenderAborted = resolve;
        }
        else
        {
            resolve();
        }
    });
}

function withRenderLock(setupFn, renderFn) 
{
    // Overwrite the onRenderAborted function to the new one.
    // This also makes sure that a single function is called when the render thread is aborted.
    //
    onRenderAborted = () => {
        // On callback, reset the onRenderAborted function to null to clear it for any future
        // resets.
        //
        onRenderAborted = null;

        // Clear state for the new render thread.
        abortRender = false;

        // New render loop with the provided function.
        renderThread = new Promise((resolve) => { 
            releaseRenderLock = resolve;
            
            // Set up render loop function
            const newRenderLoop = async (timeMS) => {
                var nextFrame = false;
                try {
                    const keepRendering = await renderFn(timeMS);
                    nextFrame = keepRendering && !abortRender;
                    if (nextFrame)
                        requestAnimationFrame(newRenderLoop);
                } catch (error) {
                    diagnosticsArea.setValue("Error when rendering: " + error.message);
                }
                finally {
                    if (!nextFrame)
                        releaseRenderLock();
                }
            }
            
            // Setup renderer and start the render loop.
            setupFn().then(() => {
                requestAnimationFrame(newRenderLoop);
            }).catch((error) => {
                diagnosticsArea.setValue(error.message);
                releaseRenderLock();
            });
        });
        
        // Queue any follow-up actions upon abort.
        renderThread.then(() => {
            renderThread = null; // Clear the render thread.
            if (onRenderAborted)
                onRenderAborted();
        })
    };

    // Is there any renderer active?
    if (!renderThread)
    {
        // Nothing to wait for. Call immediately.
        onRenderAborted();
    }
    else
    {
        // Otherwise, signal the render thread to abort.
        abortRender = true;
    }
}

function startRendering() {
    // This is a lighter-weight setup function that doesn't need to re-compile the shader code.
    const setupRenderer = async () => {
        if (!computePipeline || !passThroughPipeline)
            throw new Error("pipeline not ready");
        
        if (!currentWindowSize || currentWindowSize[0] < 2 || currentWindowSize[1] < 2)
            throw new Error("window not ready");
        
        const allocatedResources = await processResourceCommands(computePipeline, resourceBindings, resourceCommands);

        globalThis.allocatedResources = allocatedResources;
        computePipeline.createBindGroup(allocatedResources);

        passThroughPipeline.inputTexture = allocatedResources.get("outputTexture");
        passThroughPipeline.createBindGroup();

        for (const pipeline of extraComputePipelines)
            pipeline.createBindGroup(allocatedResources);
    };
    
    withRenderLock(setupRenderer, execFrame);
}

// We use the timer in the resize handler debounce the resize event, otherwise we could end of rendering
// multiple useless frames.
function resizeCanvasHandler(entries) {
    var needResize = resizeCanvas(entries);
    if (needResize) {
        startRendering();
    }
}

function toggleDisplayMode(displayMode) {
    if (currentMode == displayMode)
        return;
    if (currentMode == HIDDEN_MODE && displayMode != HIDDEN_MODE) {
        document.getElementById("resultSplitContainer").style.gridTemplateRows = "50% 14px 1fr";
    }
    if (displayMode == RENDER_MODE) {
        var printResult = document.getElementById("printResult")
        printResult.style.display = "none";
        renderOutput.style.display = "block";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        currentMode = RENDER_MODE;
    }
    else if (displayMode == PRINT_MODE) {
        renderOutput.style.display = "none";
        var printResult = document.getElementById("printResult")
        printResult.style.display = "grid";

        currentMode = PRINT_MODE;
    }
    else if (displayMode == HIDDEN_MODE) {
        renderOutput.style.display = "none";
        document.getElementById("printResult").style.display = "none";
        document.getElementById("resultSplitContainer").style.gridTemplateRows = "0px 14px 1fr";
        currentMode = HIDDEN_MODE;
    }
    else {
        console.log("Invalid display mode " + displayMode);
    }
}

var timeAggregate = 0;
var frameCount = 0;

async function execFrame(timeMS) {
    if (currentMode == HIDDEN_MODE)
        return false;
    if (currentWindowSize[0] < 2 || currentWindowSize[1] < 2)
        return false;

    const startTime = performance.now();

    var timeArray = new Float32Array(8);
    timeArray[0] = canvasCurrentMousePos.x;
    timeArray[1] = canvasCurrentMousePos.y;
    timeArray[2] = canvasLastMouseDownPos.x;
    timeArray[3] = canvasLastMouseDownPos.y;
    if (canvasIsMouseDown)
        timeArray[2] = -timeArray[2];
    if (canvasMouseClicked)
        timeArray[3] = -timeArray[3];
    timeArray[4] = timeMS * 0.001;
    computePipeline.device.queue.writeBuffer(allocatedResources.get("uniformInput"), 0, timeArray);

    // Encode commands to do the computation
    const encoder = device.createCommandEncoder({ label: 'compute builtin encoder' });

    // The extra passes always go first.
    // zip the extraComputePipelines and callCommands together
    for (const [pipeline, command] of callCommands.map((x, i) => [extraComputePipelines[i], x])) {
        const pass = encoder.beginComputePass({ label: 'extra passes' });
        pass.setBindGroup(0, pipeline.bindGroup);
        pass.setPipeline(pipeline.pipeline);
        // Determine the workgroup size based on the size of the buffer or texture.
        if (command.type == "RESOURCE_BASED") {
            if (!globalThis.allocatedResources.has(command.resourceName)) {
                diagnosticsArea.setValue("Error when dispatching " + command.fnName + ". Resource not found: " + command.resourceName);
                pass.end();
                return false;
            }

            var resource = globalThis.allocatedResources.get(command.resourceName)
            if (resource instanceof GPUBuffer) {
                var size = resource.size / 4;
                const blockSizeX = pipeline.threadGroupSize.x;
                const blockSizeY = pipeline.threadGroupSize.y;

                const workGroupSizeX = Math.floor((size + blockSizeX - 1) / blockSizeX);
                const workGroupSizeY = Math.floor((1 + blockSizeY - 1) / blockSizeY);

                pass.dispatchWorkgroups(workGroupSizeX, workGroupSizeY);
            }
            else if (resource instanceof GPUTexture) {
                var size = [0, 0];
                size[0] = resource.width;
                size[1] = resource.height;
                const blockSizeX = pipeline.threadGroupSize.x;
                const blockSizeY = pipeline.threadGroupSize.y;

                const workGroupSizeX = Math.floor((size[0] + blockSizeX - 1) / blockSizeX);
                const workGroupSizeY = Math.floor((size[1] + blockSizeY - 1) / blockSizeY);

                pass.dispatchWorkgroups(workGroupSizeX, workGroupSizeY);
            }
            else {
                pass.end();
                diagnosticsArea.setValue("Error when dispatching " + command.fnName + ". Resource type not supported for dispatch: " + resource);
                return false;
            }
        }

        pass.end();
    }

    const pass = encoder.beginComputePass({ label: 'compute builtin pass' });

    pass.setBindGroup(0, computePipeline.bindGroup);
    pass.setPipeline(computePipeline.pipeline);
    const workGroupSizeX = (currentWindowSize[0] + 15) / 16;
    const workGroupSizeY = (currentWindowSize[1] + 15) / 16;
    pass.dispatchWorkgroups(workGroupSizeX, workGroupSizeY);
    pass.end();

    if (currentMode == RENDER_MODE) {
        var renderPassDescriptor = passThroughPipeline.createRenderPassDesc();
        renderPassDescriptor.colorAttachments[0].view = context.getCurrentTexture().createView();
        const renderPass = encoder.beginRenderPass(renderPassDescriptor);

        renderPass.setBindGroup(0, passThroughPipeline.bindGroup);
        renderPass.setPipeline(passThroughPipeline.pipeline);
        renderPass.draw(6);  // call our vertex shader 6 times.
        renderPass.end();
    }

    // copy output buffer back in print mode
    if (currentMode == PRINT_MODE)
        encoder.copyBufferToBuffer(
            allocatedResources.get("outputBuffer"),
            0,
            allocatedResources.get("outputBufferRead"),
            0,
            allocatedResources.get("outputBuffer").size);

    // Finish encoding and submit the commands
    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);

    await device.queue.onSubmittedWorkDone();

    const timeElapsed = performance.now() - startTime;

    // Update performance info.
    timeAggregate += timeElapsed;
    frameCount++;
    if (frameCount == 20) {
        var avgTime = (timeAggregate / frameCount);
        document.getElementById("performanceInfo").innerText = avgTime.toFixed(1) + " ms ";
        timeAggregate = 0;
        frameCount = 0;
    }

    // Only request the next frame if we are in the render mode
    if (currentMode == RENDER_MODE)
        return true;
    else
        return false;
}

async function printResult() {
    // Encode commands to do the computation
    const encoder = device.createCommandEncoder({ label: 'compute builtin encoder' });
    encoder.clearBuffer(allocatedResources.get("printfBufferRead"));

    const pass = encoder.beginComputePass({ label: 'compute builtin pass' });

    pass.setBindGroup(0, computePipeline.bindGroup);
    pass.setPipeline(computePipeline.pipeline);
    pass.dispatchWorkgroups(1, 1);
    pass.end();

    // copy output buffer back in print mode
    encoder.copyBufferToBuffer(
        allocatedResources.get("outputBuffer"), 0, allocatedResources.get("outputBufferRead"), 0, allocatedResources.get("outputBuffer").size);
    encoder.copyBufferToBuffer(
        allocatedResources.get("g_printedBuffer"), 0, allocatedResources.get("printfBufferRead"), 0, allocatedResources.get("g_printedBuffer").size);

    // Finish encoding and submit the commands
    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);

    await device.queue.onSubmittedWorkDone();

    // Read the results once the job is done
    await allocatedResources.get("printfBufferRead").mapAsync(GPUMapMode.READ);

    var textResult = "";
    const formatPrint = parsePrintfBuffer(
        globalThis.hashedStrings,
        allocatedResources.get("printfBufferRead"),
        globalThis.printfBufferElementSize);

    if (formatPrint.length != 0)
        textResult += "Shader Output:\n" + formatPrint.join("") + "\n";

    allocatedResources.get("printfBufferRead").unmap();
    document.getElementById("printResult").value = textResult;
}

function checkShaderType(userSource) {
    // we did a pre-filter on the user input source code.
    const isImageMain = userSource.match("imageMain");
    const isPrintMain = userSource.match("printMain");

    // Only one of the main function should be defined.
    // In this case, we will know that the shader is not runnable, so we can only compile it.
    if (isImageMain == isPrintMain)
        return SlangCompiler.NON_RUNNABLE_SHADER;

    if (isImageMain)
        return SlangCompiler.RENDER_SHADER;
    else
        return SlangCompiler.PRINT_SHADER;
}

async function processResourceCommands(pipeline, resourceBindings, resourceCommands) {
    var allocatedResources = new Map();
    const safeSet = (map, key, value) => { if (map.has(key)) { map.get(key).destroy(); } map.set(key, value); };

    for (const { resourceName, parsedCommand } of resourceCommands) {
        if (parsedCommand.type === "ZEROS") {
            const size = parsedCommand.size.reduce((a, b) => a * b);
            const elementSize = 4; // Assuming 4 bytes per element (e.g., float) TODO: infer from type.
            const bindingInfo = resourceBindings.get(resourceName);
            if (!bindingInfo) {
                throw new Error(`Resource ${resourceName} is not defined in the bindings.`);
            }

            if (bindingInfo.buffer) {
                const buffer = pipeline.device.createBuffer({
                    size: size * elementSize,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });

                safeSet(allocatedResources, resourceName, buffer);

                // Initialize the buffer with zeros.
                const zeros = new Float32Array(size);
                pipeline.device.queue.writeBuffer(buffer, 0, zeros);
            } else if (bindingInfo.texture || bindingInfo.storageTexture) {
                if (parsedCommand.size.length !== 2) {
                    throw new Error(`Invalid parameter count ${parsedCommand.size.length} for ZEROS on texture ${resourceName}, should be 2.`);
                }
                try {
                    let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
                    if (bindingInfo.storageTexture) {
                        usage |= GPUTextureUsage.STORAGE_BINDING;
                    }
                    const texture = pipeline.device.createTexture({
                        size: parsedCommand.size,
                        format: bindingInfo.storageTexture?'r32float':'rgba8unorm',
                        usage: usage,
                    });

                    safeSet(allocatedResources, resourceName, texture);

                    // Initialize the texture with zeros.
                    let zeros = new Uint8Array(Array(size*elementSize).fill(0));
                    pipeline.device.queue.writeTexture({ texture }, zeros, {bytesPerRow: parsedCommand.size[0] * elementSize}, { width: parsedCommand.size[0], height: parsedCommand.size[1] });
                }
                catch (error) {
                    throw new Error(`Failed to create texture: ${error}`);
                }
            } else {
                throw new Error(`Resource ${resourceName} is an invalid type for ZEROS`);
            }
        }
        else if (parsedCommand.type === "URL") {
            // Load image from URL and wait for it to be ready.
            const bindingInfo = resourceBindings.get(resourceName);

            if (!bindingInfo) {
                throw new Error(`Resource ${resourceName} is not defined in the bindings.`);
            }

            if (!bindingInfo.texture) {
                throw new Error(`Resource ${resourceName} is not a texture.`);
            }

            const image = new Image();
            try {
                // TODO: Pop-up a warning if the image is not CORS-enabled.
                // TODO: Pop-up a warning for the user to confirm that its okay to load a cross-origin image (i.e. do you trust this code..)
                //
                image.crossOrigin = "anonymous";

                image.src = parsedCommand.url;
                await image.decode();
            }
            catch (error) {
                throw new Error(`Failed to load & decode image from URL: ${parsedCommand.url}`);
            }

            try {
                const imageBitmap = await createImageBitmap(image);
                const texture = pipeline.device.createTexture({
                    size: [imageBitmap.width, imageBitmap.height],
                    format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
                });
                pipeline.device.queue.copyExternalImageToTexture({ source: imageBitmap }, { texture: texture }, [imageBitmap.width, imageBitmap.height]);
                safeSet(allocatedResources, resourceName, texture);
            }
            catch (error) {
                throw new Error(`Failed to create texture from image: ${error}`);
            }
        }
        else if (parsedCommand.type === "RAND") {
            const size = parsedCommand.size.reduce((a, b) => a * b);
            const elementSize = 4; // Assuming 4 bytes per element (e.g., float) TODO: infer from type.
            const bindingInfo = resourceBindings.get(resourceName);
            if (!bindingInfo) {
                throw new Error(`Resource ${resourceName} is not defined in the bindings.`);
            }

            if (!bindingInfo.buffer) {
                throw new Error(`Resource ${resourceName} is not defined as a buffer.`);
            }

            const buffer = pipeline.device.createBuffer({
                size: size * elementSize,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });

            safeSet(allocatedResources, resourceName, buffer);

            // Place a call to a shader that fills the buffer with random numbers.
            if (!globalThis.randFloatPipeline) {
                const randomPipeline = new ComputePipeline(pipeline.device);

                // Load randFloat shader code from the file.
                const randFloatShaderCode = await (await fetch('demos/rand_float.slang')).text();
                const compiledResult = compiler.compile(randFloatShaderCode, "computeMain", "WGSL");
                if (!compiledResult) {
                    throw new Error("[Internal] Failed to compile randFloat shader");
                }

                let [code, layout, hashedStrings] = compiledResult;
                const module = pipeline.device.createShaderModule({ code: code });

                randomPipeline.createPipelineLayout(layout);

                // Create the pipeline (without resource bindings for now)
                randomPipeline.createPipeline(module, null);

                globalThis.randFloatPipeline = randomPipeline;
            }

            // Dispatch a random number generation shader.
            {
                const randomPipeline = globalThis.randFloatPipeline;

                // Alloc resources for the shader.
                if (!globalThis.randFloatResources)
                    globalThis.randFloatResources = new Map();

                globalThis.randFloatResources.set("outputBuffer", buffer);

                if (!globalThis.randFloatResources.has("seed"))
                    globalThis.randFloatResources.set("seed",
                        pipeline.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));

                const seedBuffer = globalThis.randFloatResources.get("seed");

                // Set bindings on the pipeline.
                globalThis.randFloatPipeline.createBindGroup(globalThis.randFloatResources);

                const seedValue = new Float32Array([Math.random(), 0, 0, 0]);
                pipeline.device.queue.writeBuffer(seedBuffer, 0, seedValue);

                // Encode commands to do the computation
                const encoder = pipeline.device.createCommandEncoder({ label: 'compute builtin encoder' });
                const pass = encoder.beginComputePass({ label: 'compute builtin pass' });

                pass.setBindGroup(0, randomPipeline.bindGroup);
                pass.setPipeline(randomPipeline.pipeline);

                const workGroupSizeX = Math.floor((size + 63) / 64);
                pass.dispatchWorkgroups(workGroupSizeX, 1);
                pass.end();

                // Finish encoding and submit the commands
                const commandBuffer = encoder.finish();
                pipeline.device.queue.submit([commandBuffer]);
                await pipeline.device.queue.onSubmittedWorkDone();
            }
        }
    }

    //
    // Some special-case allocations
    //

    safeSet(allocatedResources, "outputTexture", createOutputTexture(device, currentWindowSize[0], currentWindowSize[1], 'rgba8unorm'));

    safeSet(allocatedResources, "outputBuffer", pipeline.device.createBuffer({
        size: 2 * 2 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }));

    safeSet(allocatedResources, "outputBufferRead", pipeline.device.createBuffer({
        size: 2 * 2 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }));

    safeSet(allocatedResources, "g_printedBuffer", pipeline.device.createBuffer({
        size: printfBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }));

    safeSet(allocatedResources, "printfBufferRead", pipeline.device.createBuffer({
        size: printfBufferSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }));

    var length = new Float32Array(8).byteLength;
    safeSet(allocatedResources, "uniformInput", pipeline.device.createBuffer({ size: length, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));

    return allocatedResources;
}

function freeAllocatedResources(resources) {
    for (const resource of resources.values()) {
        resource.destroy();
    }
}

var onRun = () => {
    if (!device)
        return;
    if (!monacoEditor)
        return;
    if (!compiler)
        return;

    resetMouse();
    if (!computePipeline) {
        computePipeline = new ComputePipeline(device);
    }

    withRenderLock(
    // setupFn
    async () => {
        // We will have some restrictions on runnable shader, the user code has to define imageMain or printMain function.
        // We will do a pre-filter on the user input source code, if it's not runnable, we will not run it.
        const userSource = monacoEditor.getValue();
        const shaderType = checkShaderType(userSource);
        if (shaderType == SlangCompiler.NON_RUNNABLE_SHADER) {
            toggleDisplayMode(HIDDEN_MODE);
            codeGenArea.setValue("");
            throw new Error("Error: In order to run the shader, please define either imageMain or printMain function in the shader code.");
        }

        const entryPointName = shaderType == SlangCompiler.RENDER_SHADER ? "imageMain" : "printMain";
        const ret = compileShader(userSource, entryPointName, "WGSL");

        if (!ret.succ) {
            toggleDisplayMode(HIDDEN_MODE);
            throw new Error("");
        }

        globalThis.hashedStrings = ret.hashedStrings;

        resourceCommands = parseResourceCommands(userSource);

        try {
            callCommands = parseCallCommands(userSource);
        }
        catch (error) {
            throw new Error("Error while parsing '//! CALL' commands: " + error.message);
        }

        resourceBindings = ret.layout;
        // create a pipeline resource 'signature' based on the bindings found in the program.
        computePipeline.createPipelineLayout(resourceBindings);

        if (extraComputePipelines.length > 0)
            extraComputePipelines = []; // This should release the resources of the extra pipelines.

        if (callCommands && (callCommands.length > 0)) {
            for (const command of callCommands) {
                const compiledResult = compileShader(userSource, command.fnName, "WGSL");
                if (!compiledResult.succ) {
                    throw new Error("Failed to compile shader for requested entry-point: " + command.fnName);
                }

                const module = device.createShaderModule({ code: compiledResult.code });
                const pipeline = new ComputePipeline(device);
                pipeline.createPipelineLayout(compiledResult.layout);
                pipeline.createPipeline(module, null);
                pipeline.setThreadGroupSize(compiledResult.threadGroupSize);
                extraComputePipelines.push(pipeline);
            }
        }

        const allocatedResources = await processResourceCommands(computePipeline, resourceBindings, resourceCommands);
        
        globalThis.allocatedResources = allocatedResources;

        if (!passThroughPipeline) {
            passThroughPipeline = new GraphicsPipeline(device);
            const shaderModule = device.createShaderModule({ code: passThroughshaderCode });
            const inputTexture = allocatedResources.get("outputTexture");
            passThroughPipeline.createPipeline(shaderModule, inputTexture);
        }

        passThroughPipeline.inputTexture = allocatedResources.get("outputTexture");
        passThroughPipeline.createBindGroup();

        const module = device.createShaderModule({ code: ret.code });
        computePipeline.createPipeline(module, allocatedResources);

        // Create bind groups for the extra pipelines
        for (const pipeline of globalThis.extraComputePipelines)
            pipeline.createBindGroup(allocatedResources);

        toggleDisplayMode(compiler.shaderType);
    },
    // renderFn
    async (timeMS) => 
    {
        if (compiler.shaderType == SlangCompiler.PRINT_SHADER) {
            await printResult();
            return false; // Stop after one frame.
        }
        else if (compiler.shaderType == SlangCompiler.RENDER_SHADER) {
            return await execFrame(timeMS);
        }
        return false;
    });
}

function appendOutput(editor, textLine) {
    editor.setValue(editor.getValue() + textLine + "\n");
}

function compileOrRun() {
    const userSource = monacoEditor.getValue();
    const shaderType = checkShaderType(userSource);

    if (shaderType == SlangCompiler.NON_RUNNABLE_SHADER) {
        onCompile();
    }
    else {
        if (device == null) {
            onCompile().then(() => {
                if (diagnosticsArea.getValue() == "")
                    appendOutput(diagnosticsArea, `The shader compiled successfully,` +
                        `but it cannot run because your browser does not support WebGPU.\n` +
                        `WebGPU is supported in Chrome, Edge, Firefox Nightly and Safari Technology Preview. ` +
                        `On iOS, WebGPU support requires Safari 16.4 or later and must be enabled in settings. ` +
                        `Please check your browser version and enable WebGPU if possible.`);
            });
        }
        else {
            onRun();
        }
    }
}

var reflectionJson = {};
function getReflectionJson() {
    return {
        controlPanel: { enabled: false },
        sideMenu: { enabled: false },
        footer: { enabled: false },
        lineNumbers: { enabled: false },
        inspectionLevels: 8,
        shortcutKeysEnabled: false,
        title: {
            text: null,
            showCloseOpenAllButtons: false,
            showCopyButton: false,
            enableFullScreenToggling: false
        },
        data: reflectionJson
    };
}
function compileShader(userSource, entryPoint, compileTarget, includePlaygroundModule = true) {
    const compiledResult = compiler.compile(userSource, entryPoint, compileTarget);
    diagnosticsArea.setValue(compiler.diagnosticsMsg);

    // If compile is failed, we just clear the codeGenArea
    if (!compiledResult) {
        codeGenArea.setValue('Compilation returned empty result.');
        return { succ: false };
    }

    let [compiledCode, layout, hashedStrings, reflectionJsonObj, threadGroupSize] = compiledResult;
    reflectionJson = reflectionJsonObj;

    codeGenArea.setValue(compiledCode);
    if (compileTarget == "WGSL")
        codeGenArea.getModel().setLanguage("wgsl");
    else if (compileTarget == "SPIRV")
        codeGenArea.getModel().setLanguage("spirv");
    else
        codeGenArea.getModel().setLanguage("generic-shader");

    // Update reflection info.
    $jsontree.setJson("reflectionDiv", reflectionJson);
    $jsontree.refreshAll();

    return { succ: true, code: compiledCode, layout: layout, hashedStrings: hashedStrings, reflection: reflectionJson, threadGroupSize: threadGroupSize };
}

// For the compile button action, we don't have restriction on user code that it has to define imageMain or printMain function.
// But if it doesn't define any of them, then user code has to define a entry point function name. Because our built-in shader
// have no way to call the user defined function, and compile engine cannot compile the source code.
var onCompile = async () => {

    toggleDisplayMode(HIDDEN_MODE);
    const compileTarget = document.getElementById("target-select").value;

    const entryPoint = document.getElementById("entrypoint-select").value;
    if (entryPoint == "" && !isWholeProgramTarget(compileTarget)) {
        diagnosticsArea.setValue("Please select the entry point name");
        return;
    }

    if (compileTarget == "SPIRV")
        await compiler.initSpirvTools();

    // compile the compute shader code from input text area
    const userSource = monacoEditor.getValue();
    compileShader(userSource, entryPoint, compileTarget);

    if (compiler.diagnosticsMsg.length > 0) {
        diagnosticsArea.setValue(compiler.diagnosticsMsg);
        return;
    }
}

function loadEditor(readOnlyMode = false, containerId, preloadCode) {

    require(["vs/editor/editor.main"], function () {
        var container = document.getElementById(containerId);
        initMonaco();
        var model = readOnlyMode
            ? monaco.editor.createModel(preloadCode)
            : monaco.editor.createModel("", "slang", monaco.Uri.parse(userCodeURI));
        var editor = monaco.editor.create(container, {
            model: model,
            language: readOnlyMode ? 'csharp' : 'slang',
            theme: 'slang-dark',
            readOnly: readOnlyMode,
            lineNumbers: readOnlyMode ? "off" : "on",
            automaticLayout: true,
            wordWrap: containerId == "diagnostics" ? "on" : "off",
            "semanticHighlighting.enabled": true,
            renderValidationDecorations: "on",
            minimap: {
                enabled: false
            },
        });
        if (!readOnlyMode) {
            model.onDidChangeContent(codeEditorChangeContent);
            model.setValue(preloadCode);
        }

        if (containerId == "codeEditor")
            monacoEditor = editor;
        else if (containerId == "diagnostics") {
            var model = editor.getModel();
            monaco.editor.setModelLanguage(model, "text")
            diagnosticsArea = editor;
        }
        else if (containerId == "codeGen") {
            codeGenArea = editor;
        }
    });
}


// Event when loading the WebAssembly module
var moduleLoadingMessage = "";

// Define the Module object with a callback for initialization
var Module = {
    locateFile: function (path) {
        if (path.endsWith('.wasm')) {
            return 'slang-wasm.wasm.gz'; // Use the gzip compressed file
        }
        return path;
    },
    instantiateWasm: async function (imports, receiveInstance) {
        // Step 1: Fetch the compressed .wasm.gz file
        var progressBar = document.getElementById('progress-bar');
        const compressedData = await fetchWithProgress('slang-wasm.wasm.gz', (loaded, total) => {
            const progress = (loaded / total) * 100;
            if (progressBar == null) progressBar = document.getElementById('progress-bar');
            if (progressBar) progressBar.style.width = `${progress}%`;
        });

        // Step 2: Decompress the gzip data
        const wasmBinary = loadPako().inflate(compressedData);

        // Step 3: Instantiate the WebAssembly module from the decompressed data
        const { instance } = await WebAssembly.instantiate(wasmBinary, imports);
        receiveInstance(instance);
        return instance.exports;
    },
    onRuntimeInitialized: function () {
        var label = document.getElementById("loadingStatusLabel");
        if (label)
            label.innerText = "Initializing Slang Compiler...";
        compiler = new SlangCompiler(Module);
        var result = compiler.init();
        slangd = Module.createLanguageServer();
        if (result.ret) {
            document.getElementById("compile-btn").disabled = false;
            moduleLoadingMessage = "Slang compiler initialized successfully.\n";
            runIfFullyInitialized();
        }
        else {
            console.log(result.msg);
            moduleLoadingMessage = "Failed to initialize Slang Compiler, Run and Compile features are disabled.\n";
        }
    }
};

var pageLoaded = false;
// event when loading the page
window.onload = async function () {
    pageLoaded = true;

    await webgpuInit();
    if (device) {
        document.getElementById("run-btn").disabled = false;
    }
    else {
        diagnosticsArea.setValue(moduleLoadingMessage + "Browser does not support WebGPU, Run shader feature is disabled.");
        document.getElementById("run-btn").title = "Run shader feature is disabled because the current browser does not support WebGPU.";
    }
    runIfFullyInitialized();
}

function runIfFullyInitialized() {
    if (compiler && slangd && pageLoaded) {
        initLanguageServer();

        const loadingScreen = document.getElementById('loading-screen');
        // Start fade-out by setting opacity to 0
        loadingScreen.style.opacity = '0';
        // Wait for the transition to finish before hiding completely
        loadingScreen.addEventListener('transitionend', () => {
            loadingScreen.style.display = 'none';
        });
        document.getElementById('contentDiv').style = "";

        restoreSelectedTargetFromURL();

        if (restoreDemoSelectionFromURL()) { }
        else if (monacoEditor.getValue() == "") {
            loadDemo(defaultShaderURL);
        }
        else {
            compileOrRun();
        }
    }
}